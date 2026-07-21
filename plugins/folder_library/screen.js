/* Folder Browser — screen.js
 * Plain JS, global scope, IIFE. Follows feedBack plugin conventions.
 *
 * ONE shared implementation (`createFolderSurface`) parameterised by a
 * "surface config", consumed by two thin adapters:
 *   • NAV adapter  — the standalone "Folders" nav-screen in the classic (v2)
 *     UI. Owns its own toolbar + search (#fb-*), client-side filter panel and
 *     local sort, renders into #fb-tree.
 *   • LIB adapter  — the folder VIEW embedded in the v3 Songs page. Uses host
 *     chrome (host search #v3-search/#lib-filter, host filter params, host
 *     sort), renders into #lib-folder-tree, injects a toolbar into
 *     #lib-folder-controls, and exposes window.folderLibrary = {load, unload}.
 *
 * Each surface is an independent factory instance with its own closure state,
 * so the two never share mutable state even when both run on the same page
 * (they do in classic v2, where #lib-folder-tree also exists).
 */
(function () {
'use strict';

const API = '/api/plugins/folder_library';

// ════════════════════════════════════════════════════════════════════════
//  Shared surface factory
// ════════════════════════════════════════════════════════════════════════
function createFolderSurface(cfg) {

    // ── Safe localStorage helpers (cfg.storePrefix keeps surfaces separate) ─
    function _store(key, val) {
        try {
            if (val === undefined) return localStorage.getItem(cfg.storePrefix + key);
            localStorage.setItem(cfg.storePrefix + key, val);
        } catch (_) { return null; }
    }
    function _storeJSON(key, val) {
        try {
            if (val === undefined) return JSON.parse(localStorage.getItem(cfg.storePrefix + key) || 'null');
            localStorage.setItem(cfg.storePrefix + key, JSON.stringify(val));
        } catch (_) { return null; }
    }

    // ── State ───────────────────────────────────────────────────────────
    let _tree             = null;
    let _loaded           = false;
    let _lastFilterParams = null;             // params string used for the last /tree fetch
    let _openFolders      = new Set(_storeJSON('open') || []);
    let _unsortedOpen     = _store(cfg.unsortedKey) !== 'false';
    let _view             = _store('view') || 'list';  // 'list' | 'grid'
    let _sort             = _store('sort') || 'default';
    let _sortDir          = _store('sortDir') || 'asc';
    let _toolbarDone      = false;
    let _hoveredFolder    = null;             // { wrap, hdr, btnGroup } — only innermost folder is active
    let _previewHover     = _store('previewHover') === 'true';  // opt-in: preview a song's audio on hover
    let _previewTimer     = null;
    let _previewAudio     = null;   // dedicated element — never touches the main player's <audio>
    let _previewSeq       = 0;      // invalidates in-flight loads when the hover moves or stops

    // ── Core arrangement order (pinned to top of filter panel) ──────────
    const _CORE_ARRANGEMENTS = ['Lead', 'Rhythm', 'Bass', 'Combo'];

    // ── Client-side filter state (nav surface only) ─────────────────────
    var _filtersRaw = _storeJSON('filters') || {};
    function _normFilterGroup(g) {
        var out = {};
        for (var k in (g || {})) {
            var v = g[k];
            out[k] = v === 'require' ? 'on' : v === 'any' ? 'off' : v;
        }
        return out;
    }
    let _filters = {
        arrangements: _normFilterGroup(_filtersRaw.arrangements),
        stems:        _normFilterGroup(_filtersRaw.stems),
        lyrics:       (_filtersRaw.lyrics === 'require' || _filtersRaw.lyrics === 'on') ? 'on'
                    : (_filtersRaw.lyrics === 'exclude') ? 'exclude' : 'off',
        tunings:      _filtersRaw.tunings || [],
    };

    // ── DOM helpers ─────────────────────────────────────────────────────
    function _el(id) { return document.getElementById(id); }
    function _treeEl() { return document.getElementById(cfg.treeId); }

    // ── Force screen to have height (nav screen has no height set) ──────
    function _fixHeight() {
        const el  = _el(cfg.screenId);
        const nav = document.querySelector('nav');
        const navH = nav ? nav.offsetHeight : 64;
        if (el) el.style.minHeight = (window.innerHeight - navH) + 'px';
    }

    // ── Close the nav plugin dropdown (sits at z-50 and blocks clicks) ──
    function _closeDropdown() {
        var dd = _el('plugin-dropdown');
        if (dd) dd.classList.add('hidden');
    }

    // ── Status (nav status bar only) ────────────────────────────────────
    // Gated by cfg.ownsStatus so the library surface never mutates the nav
    // screen's shared #fb-status element when both instances live on one page.
    function _status(msg, isErr) {
        if (!cfg.ownsStatus) return;
        const el = _el('fb-status');
        if (!el) return;
        el.textContent = msg || '';
        el.className = 'text-xs ml-1 ' + (isErr ? 'text-red-400' : 'text-gray-500');
    }

    // ── API helper ──────────────────────────────────────────────────────
    async function _api(path, body) {
        const opts = body
            ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
            : {};
        const res  = await fetch(cfg.apiBase + path, opts);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Request failed');
        return data;
    }

    // ── Search value (read live from the surface's search input) ────────
    function _query() {
        var el = cfg.getSearchEl ? cfg.getSearchEl() : null;
        return el ? el.value.trim() : '';
    }

    // ── Flat list of every song in the tree (root + all nested folders) ─
    function _allSongs() {
        if (!_tree) return [];
        var result = _tree.root_songs.slice();
        function _collectFolder(f) {
            f.songs.forEach(function (s) { result.push(s); });
            (f.children || []).forEach(_collectFolder);
        }
        _tree.folders.forEach(_collectFolder);
        return result;
    }

    // ── Dynamic arrangement / stem discovery (filter panel) ─────────────
    function _getArrangements() {
        var counts = {};
        _allSongs().forEach(function (s) {
            (s.arrangements || []).forEach(function (a) { counts[a] = (counts[a] || 0) + 1; });
        });
        return Object.keys(counts).sort(function (a, b) { return (counts[b] - counts[a]) || a.localeCompare(b); });
    }
    function _getStems() {
        var counts = {};
        _allSongs().forEach(function (s) {
            (s.stems || []).forEach(function (st) { counts[st] = (counts[st] || 0) + 1; });
        });
        return Object.keys(counts).sort(function (a, b) { return (counts[b] - counts[a]) || a.localeCompare(b); });
    }
    function _getAvailableFilters() {
        var out = { arrangements: false, stems: false, lyrics: false, tuning: false };
        _allSongs().forEach(function (s) {
            if ((s.arrangements || []).length) out.arrangements = true;
            if ((s.stems        || []).length) out.stems        = true;
            if (s.lyrics)                      out.lyrics       = true;
            if (s.tuning)                      out.tuning       = true;
        });
        return out;
    }
    function _getTunings() {
        var counts = {};
        _allSongs().forEach(function (s) {
            var t = s.tuning ? String(s.tuning).trim() : '';
            if (t) counts[t] = (counts[t] || 0) + 1;
        });
        return Object.keys(counts)
            .sort(function (a, b) { return a.localeCompare(b); })
            .map(function (t) { return { tuning: t, count: counts[t] }; });
    }

    // ── Fetch tree ──────────────────────────────────────────────────────
    async function _load(force) {
        // Lib surface owns a couple of host-chrome tweaks on entry.
        if (cfg.searchInputId) {
            var fe = _el(cfg.searchInputId);
            if (fe) fe.style.maxWidth = '320px';
        }
        if (cfg.countId) {
            var ce0 = _el(cfg.countId);
            if (ce0) ce0.textContent = '';
        }

        var params = cfg.getFilterParams ? cfg.getFilterParams() : '';
        if (!force && _loaded && _tree && params === _lastFilterParams) {
            if (cfg.injectToolbar) _injectToolbar();
            _render();
            return;
        }

        _status('Loading…');
        var treeEl = _treeEl();
        if (!cfg.ownsStatus && treeEl) {
            treeEl.innerHTML = '<div style="padding:48px;text-align:center;color:#4b5563;font-size:13px;">Loading folders…</div>';
        }
        try {
            var url  = '/tree' + (params ? '?' + params : '');
            var data = await _api(url);
            if (data.error) {
                if (cfg.ownsStatus) _status('⚠ ' + data.error, true);
                else if (treeEl) { treeEl.innerHTML = ''; var _ed = document.createElement('div'); _ed.style.cssText = 'padding:48px;text-align:center;color:#ef4444;font-size:13px;'; _ed.textContent = '⚠ ' + data.error; treeEl.appendChild(_ed); }
                return;
            }
            _tree             = data;
            _loaded           = true;
            _lastFilterParams = params;
            _status('');
            // Lib auto-expands top-level folders on first visit (empty open set).
            if (cfg.autoExpandTop && _openFolders.size === 0 && data.folders.length) {
                data.folders.forEach(function (f) { _openFolders.add(f.path); });
                _storeJSON('open', [..._openFolders]);
            }
            if (cfg.injectToolbar) _injectToolbar();
            _render();
            // Rebuild filter panel if it's open so tuning list reflects new data.
            if (cfg.ownsFilterPanel) {
                var fp = _el('fb-filter-panel');
                if (fp && fp.style.display !== 'none') _buildFilterPanel();
            }
        } catch (err) {
            if (cfg.ownsStatus) _status('Load failed: ' + err.message, true);
            else if (treeEl) { treeEl.innerHTML = ''; var _ed = document.createElement('div'); _ed.style.cssText = 'padding:48px;text-align:center;color:#ef4444;font-size:13px;'; _ed.textContent = '⚠ Failed to load: ' + err.message; treeEl.appendChild(_ed); }
        }
    }

    // ── Filtered tree ───────────────────────────────────────────────────
    // Search always applies. Nav additionally applies its client-side filter
    // panel; lib additionally narrows by host artist/album (server already
    // applied arrangement/stem/tuning filters via /tree params).
    function _filtered() {
        if (!_tree) return { folders: [], root_songs: [] };
        var q      = _query().toLowerCase();
        var artist = cfg.getHostArtist ? cfg.getHostArtist() : '';
        var album  = cfg.getHostAlbum  ? cfg.getHostAlbum()  : '';
        var hasClientFilters = cfg.ownsFilterPanel && _activeFilterCount() > 0;
        if (!q && !artist && !album && !hasClientFilters) return _tree;
        function _keep(s) {
            if (artist && (s.artist || '') !== artist) return false;
            if (album  && (s.album  || '') !== album)  return false;
            if (q && !(
                (s.title  || '').toLowerCase().includes(q) ||
                (s.artist || '').toLowerCase().includes(q) ||
                (s.album  || '').toLowerCase().includes(q) ||
                s.filename.toLowerCase().includes(q)
            )) return false;
            if (hasClientFilters && !_matchFilters(s)) return false;
            return true;
        }
        function _filterFolder(f) {
            var songs    = f.songs.filter(_keep);
            var children = (f.children || []).map(_filterFolder).filter(function (c) {
                return c.songs.length || (c.children || []).length;
            });
            return { name: f.name, path: f.path, songs: songs, children: children };
        }
        var folders = _tree.folders.map(_filterFolder).filter(function (f) {
            return f.songs.length || (f.children || []).length;
        });
        return { folders: folders, root_songs: _tree.root_songs.filter(_keep) };
    }

    // ── Client-side filter helpers (nav surface) ────────────────────────
    function _saveFilters() {
        _storeJSON('filters', _filters);
    }
    function _activeFilterCount() {
        var n = 0;
        var arrVals = _filters.arrangements || {};
        for (var a in arrVals) { if (arrVals[a] === 'on' || arrVals[a] === 'exclude') n++; }
        var stemVals = _filters.stems || {};
        for (var s in stemVals) { if (stemVals[s] === 'on' || stemVals[s] === 'exclude') n++; }
        if (_filters.lyrics === 'on' || _filters.lyrics === 'exclude') n++;
        n += (_filters.tunings || []).length;
        return n;
    }
    function _matchFilters(song) {
        // Arrangements — include uses OR, exclude uses AND.
        var arrF    = _filters.arrangements || {};
        var songArr = song.arrangements || [];
        var onArr   = Object.keys(arrF).filter(function (a) { return arrF[a] === 'on'; });
        if (onArr.length && !onArr.some(function (a) { return songArr.indexOf(a) !== -1; })) return false;
        for (var a in arrF) {
            if (arrF[a] === 'exclude' && songArr.indexOf(a) !== -1) return false;
        }
        // Stems — same OR-include / AND-exclude logic.
        var stemsF    = _filters.stems || {};
        var songStems = song.stems || [];
        var onStems   = Object.keys(stemsF).filter(function (s) { return stemsF[s] === 'on'; });
        if (onStems.length && !onStems.some(function (s) { return songStems.indexOf(s) !== -1; })) return false;
        for (var s in stemsF) {
            if (stemsF[s] === 'exclude' && songStems.indexOf(s) !== -1) return false;
        }
        if (_filters.lyrics === 'on'      && !song.lyrics) return false;
        if (_filters.lyrics === 'exclude' &&  song.lyrics) return false;
        var tunings = _filters.tunings || [];
        if (tunings.length) {
            var t = (song.tuning || '').trim();
            if (!t || tunings.indexOf(t) === -1) return false;
        }
        return true;
    }

    // Split pill: left zone = include, right zone = exclude. state: 'off'|'on'|'exclude'
    function _makeSplitPill(label, state, onChange) {
        var pill = document.createElement('div');
        pill.style.cssText = 'display:inline-flex; border-radius:20px; border:1px solid; overflow:hidden;';
        var incBtn = document.createElement('button');
        incBtn.style.cssText = 'padding:4px 10px; background:none; border:none; border-right:1px solid; font-size:12px; cursor:pointer; white-space:nowrap;';
        incBtn.textContent = label;
        var excBtn = document.createElement('button');
        excBtn.style.cssText = 'padding:4px 8px; background:none; border:none; font-size:11px; cursor:pointer; line-height:1;';
        excBtn.title = 'Exclude';
        excBtn.textContent = '✕';
        function _apply() {
            if (state === 'on') {
                pill.style.borderColor   = '#2563eb';
                incBtn.style.background  = '#1d4ed8';
                incBtn.style.color       = '#fff';
                incBtn.style.borderRightColor = '#3b82f6';
                excBtn.style.background  = '#1d4ed8';
                excBtn.style.color       = 'rgba(255,255,255,0.45)';
            } else if (state === 'exclude') {
                pill.style.borderColor   = '#991b1b';
                incBtn.style.background  = 'transparent';
                incBtn.style.color       = '#fca5a5';
                incBtn.style.borderRightColor = '#7f1d1d';
                excBtn.style.background  = 'transparent';
                excBtn.style.color       = '#ef4444';
            } else {
                pill.style.borderColor   = '#374151';
                incBtn.style.background  = 'transparent';
                incBtn.style.color       = '#6b7280';
                incBtn.style.borderRightColor = '#374151';
                excBtn.style.background  = 'transparent';
                excBtn.style.color       = '#4b5563';
            }
        }
        _apply();
        incBtn.addEventListener('click', function () {
            state = (state === 'on') ? 'off' : 'on';
            _apply(); onChange(state);
        });
        excBtn.addEventListener('click', function () {
            state = (state === 'exclude') ? 'off' : 'exclude';
            _apply(); onChange(state);
        });
        pill.appendChild(incBtn);
        pill.appendChild(excBtn);
        return pill;
    }

    // ── Song date info (year + date added) — hover reveal (nav) ─────────
    function _buildSongDateInfo(song) {
        var parts = [];
        if (song.year != null && song.year !== '') parts.push(String(song.year));
        if (song.added) {
            var d = new Date(song.added * 1000);
            parts.push(d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }));
        }
        if (!parts.length) return null;
        var el = document.createElement('div');
        el.style.cssText = 'font-size:11px; font-weight:500; color:#cbd5e1; ' +
            'max-height:0; opacity:0; overflow:hidden; margin-top:0; ' +
            'transition:max-height 0.2s ease, opacity 0.15s, margin-top 0.15s;';
        el.textContent = parts.join('  ·  ');
        return el;
    }

    // ── Song metadata badges (visible on hover; click toggles a filter) ─
    function _badge(text, active, type) {
        var b = document.createElement('span');
        var _typeColors = {
            arrangement: { border: '#92400e', color: '#fcd34d' },
            stem:        { border: '#5b21b6', color: '#c4b5fd' },
            lyrics:      { border: '#9f1239', color: '#fda4af' },
            tuning:      { border: '#0f766e', color: '#5eead4' },
        };
        var tc = (!active && type) ? (_typeColors[type] || null) : null;
        b.style.cssText = 'display:inline-block; padding:1px 6px; border-radius:3px; ' +
            'font-size:10px; font-weight:500; white-space:nowrap; cursor:pointer; ' +
            'border:1px solid ' + (active ? '#3b82f6' : (tc ? tc.border : '#334155')) + '; ' +
            'background:' + (active ? '#1d4ed8' : 'transparent') + '; ' +
            'color:'      + (active ? '#fff'    : (tc ? tc.color : '#cbd5e1')) + ';';
        b.textContent = text;
        return b;
    }
    function _buildSongBadges(song) {
        var wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex; flex-wrap:wrap; gap:3px; ' +
            'max-height:0; opacity:0; overflow:hidden; margin-top:0; ' +
            'transition:max-height 0.2s ease, opacity 0.15s, margin-top 0.15s;';
        var any = false;
        var _seenArr  = {};
        var _seenStem = {};
        (song.arrangements || []).forEach(function (a) {
            if (_seenArr[a]) return; _seenArr[a] = true;
            var active = ((_filters.arrangements || {})[a] === 'on');
            var b = _badge(a, active, 'arrangement');
            b.addEventListener('click', function (e) {
                e.stopPropagation();
                if (!_filters.arrangements) _filters.arrangements = {};
                _filters.arrangements[a] = active ? 'off' : 'on';
                _saveFilters(); _updateFilterBadge(); _render();
            });
            wrap.appendChild(b); any = true;
        });
        (song.stems || []).forEach(function (s) {
            if (_seenStem[s]) return; _seenStem[s] = true;
            var active = ((_filters.stems || {})[s] === 'on');
            var b = _badge(s, active, 'stem');
            b.addEventListener('click', function (e) {
                e.stopPropagation();
                if (!_filters.stems) _filters.stems = {};
                _filters.stems[s] = active ? 'off' : 'on';
                _saveFilters(); _updateFilterBadge(); _render();
            });
            wrap.appendChild(b); any = true;
        });
        if (song.lyrics) {
            var lyrActive = (_filters.lyrics === 'on');
            var lb = _badge('♪ Lyrics', lyrActive, 'lyrics');
            lb.addEventListener('click', function (e) {
                e.stopPropagation();
                _filters.lyrics = lyrActive ? 'off' : 'on';
                _saveFilters(); _updateFilterBadge(); _render();
            });
            wrap.appendChild(lb); any = true;
        }
        if (song.tuning) {
            var t = song.tuning.trim();
            var tunActive = (_filters.tunings || []).indexOf(t) !== -1;
            var tb = _badge(t, tunActive, 'tuning');
            tb.addEventListener('click', function (e) {
                e.stopPropagation();
                if (!_filters.tunings) _filters.tunings = [];
                var idx = _filters.tunings.indexOf(t);
                if (idx !== -1) _filters.tunings.splice(idx, 1);
                else            _filters.tunings.push(t);
                _saveFilters(); _updateFilterBadge(); _render();
            });
            wrap.appendChild(tb); any = true;
        }
        return any ? wrap : null;
    }
    function _revealBadges(el) {
        el.style.maxHeight  = '120px';
        el.style.opacity    = '1';
        el.style.marginTop  = '4px';
    }
    function _hideBadges(el) {
        el.style.maxHeight  = '0';
        el.style.opacity    = '0';
        el.style.marginTop  = '0';
    }
    function _updateFilterBadge() {
        var badge = _el('fb-filter-badge');
        if (!badge) return;
        var n = _activeFilterCount();
        badge.style.display = n ? 'block' : 'none';
        badge.textContent   = String(n);
    }

    // ── Filter panel sections (nav) ─────────────────────────────────────
    function _makePillSection(sectionTitle, items, filterKey, extraItems) {
        var section = document.createElement('div');
        section.style.marginBottom = '20px';
        var hdr = document.createElement('div');
        hdr.style.cssText = 'font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:#6b7280; margin-bottom:8px;';
        hdr.textContent = sectionTitle;
        section.appendChild(hdr);
        var pills = document.createElement('div');
        pills.style.cssText = 'display:flex; flex-wrap:wrap; gap:6px;';
        function _addPill(item) {
            var state = ((_filters[filterKey] || {})[item]) || 'off';
            pills.appendChild(_makeSplitPill(item, state, function (next) {
                if (!_filters[filterKey]) _filters[filterKey] = {};
                _filters[filterKey][item] = next;
                _saveFilters(); _updateFilterBadge(); _render();
            }));
        }
        items.forEach(_addPill);
        if (extraItems && extraItems.length) {
            var sep = document.createElement('div');
            sep.style.cssText = 'width:100%; height:1px; background:#1f2937; margin:4px 0 2px;';
            pills.appendChild(sep);
            extraItems.forEach(_addPill);
        }
        section.appendChild(pills);
        return section;
    }
    function _makeLyricsSection() {
        var section = document.createElement('div');
        section.style.marginBottom = '20px';
        var hdr = document.createElement('div');
        hdr.style.cssText = 'font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:#6b7280; margin-bottom:8px;';
        hdr.textContent = 'LYRICS';
        section.appendChild(hdr);
        var state = _filters.lyrics || 'off';
        section.appendChild(_makeSplitPill('Lyrics', state, function (next) {
            _filters.lyrics = next;
            _saveFilters(); _updateFilterBadge(); _render();
        }));
        return section;
    }
    function _makeTuningSection() {
        var section = document.createElement('div');
        section.style.marginBottom = '20px';
        var tunings = _getTunings();
        if (!tunings.length) return section;
        var titleRow = document.createElement('div');
        titleRow.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;';
        var titleEl = document.createElement('div');
        titleEl.style.cssText = 'font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:#6b7280;';
        titleEl.textContent = 'TUNING';
        var allLbl = document.createElement('span');
        allLbl.style.cssText = 'font-size:11px; color:#6b7280;';
        function _updateAllLbl() {
            var n = (_filters.tunings || []).length;
            allLbl.textContent = n ? n + ' selected' : 'All tunings';
        }
        _updateAllLbl();
        titleRow.appendChild(titleEl);
        titleRow.appendChild(allLbl);
        section.appendChild(titleRow);
        var list = document.createElement('div');
        list.style.cssText = 'display:flex; flex-direction:column; gap:2px;';
        tunings.forEach(function (entry) {
            var row = document.createElement('label');
            row.style.cssText = 'display:flex; align-items:center; gap:8px; padding:5px 4px; cursor:pointer; border-radius:4px;';
            row.addEventListener('mouseenter', function () { row.style.background = '#111827'; });
            row.addEventListener('mouseleave', function () { row.style.background = ''; });
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.style.cssText = 'width:14px; height:14px; accent-color:#3b82f6; cursor:pointer; flex-shrink:0;';
            cb.checked = (_filters.tunings || []).indexOf(entry.tuning) !== -1;
            var lbl = document.createElement('span');
            lbl.style.cssText = 'flex:1; font-size:13px; color:#d1d5db;';
            lbl.textContent = entry.tuning;
            var cnt = document.createElement('span');
            cnt.style.cssText = 'font-size:12px; color:#6b7280; font-variant-numeric:tabular-nums;';
            cnt.textContent = entry.count;
            cb.addEventListener('change', function () {
                if (!_filters.tunings) _filters.tunings = [];
                if (cb.checked) {
                    if (_filters.tunings.indexOf(entry.tuning) === -1)
                        _filters.tunings.push(entry.tuning);
                } else {
                    _filters.tunings = _filters.tunings.filter(function (t) { return t !== entry.tuning; });
                }
                _saveFilters(); _updateAllLbl(); _updateFilterBadge(); _render();
            });
            row.appendChild(cb);
            row.appendChild(lbl);
            row.appendChild(cnt);
            list.appendChild(row);
        });
        section.appendChild(list);
        return section;
    }

    // ── Filter panel open / close (nav) ─────────────────────────────────
    function _buildFilterPanel() {
        var panel = _el('fb-filter-panel');
        if (!panel) return;
        panel.innerHTML = '';
        var hdr = document.createElement('div');
        hdr.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:14px 20px; border-bottom:1px solid #1f2937; flex-shrink:0;';
        var titleEl = document.createElement('span');
        titleEl.style.cssText = 'font-size:15px; font-weight:600; color:#e5e7eb;';
        titleEl.textContent = 'Filters';
        var closeBtn = document.createElement('button');
        closeBtn.style.cssText = 'padding:4px; color:#6b7280; background:none; border:none; cursor:pointer; border-radius:4px;';
        closeBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" style="width:16px;height:16px"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>';
        closeBtn.addEventListener('click', _closeFilterPanel);
        hdr.appendChild(titleEl);
        hdr.appendChild(closeBtn);
        panel.appendChild(hdr);
        var content = document.createElement('div');
        content.style.cssText = 'overflow-y:auto; flex:1; padding:16px 20px;';
        var arrangements = _getArrangements();
        var stems        = _getStems();
        var avail        = _getAvailableFilters();
        if (arrangements.length) {
            var coreArr  = _CORE_ARRANGEMENTS.filter(function (a) { return arrangements.indexOf(a) !== -1; });
            var otherArr = arrangements.filter(function (a) { return _CORE_ARRANGEMENTS.indexOf(a) === -1; });
            content.appendChild(_makePillSection('ARRANGEMENTS',
                coreArr.length ? coreArr : arrangements,
                'arrangements',
                coreArr.length ? otherArr : []
            ));
        }
        if (stems.length)  content.appendChild(_makePillSection('STEMS (sloppak)', stems, 'stems'));
        if (avail.lyrics)  content.appendChild(_makeLyricsSection());
        if (avail.tuning)  content.appendChild(_makeTuningSection());
        panel.appendChild(content);
        var footer = document.createElement('div');
        footer.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:14px 20px; border-top:1px solid #1f2937; flex-shrink:0;';
        var clearBtn = document.createElement('button');
        clearBtn.style.cssText = 'font-size:13px; color:#6b7280; background:none; border:none; cursor:pointer; padding:0;';
        clearBtn.textContent = 'Clear all';
        clearBtn.addEventListener('click', function () {
            _filters = { arrangements: {}, stems: {}, lyrics: 'off', tunings: [] };
            _saveFilters(); _updateFilterBadge(); _render();
            _buildFilterPanel();
        });
        var doneBtn = document.createElement('button');
        doneBtn.style.cssText = 'padding:6px 20px; border-radius:6px; border:none; background:#3b82f6; color:#fff; font-size:13px; cursor:pointer; font-weight:500;';
        doneBtn.textContent = 'Done';
        doneBtn.addEventListener('click', _closeFilterPanel);
        footer.appendChild(clearBtn);
        footer.appendChild(doneBtn);
        panel.appendChild(footer);
    }
    function _openFilterPanel() {
        _buildFilterPanel();
        var panel    = _el('fb-filter-panel');
        var backdrop = _el('fb-filter-backdrop');
        if (panel)    panel.style.display    = 'flex';
        if (backdrop) backdrop.style.display = 'block';
    }
    function _closeFilterPanel() {
        var panel    = _el('fb-filter-panel');
        var backdrop = _el('fb-filter-backdrop');
        if (panel)    panel.style.display    = 'none';
        if (backdrop) backdrop.style.display = 'none';
    }

    // ── Sort helper ─────────────────────────────────────────────────────
    function _sortSongs(songs) {
        if (cfg.ownsSort) {
            // Nav: local sort state (#fb-sort + direction toggle).
            if (_sort === 'default') return songs;
            var arr = songs.slice();
            if (_sort === 'title') {
                arr.sort(function (a, b) { return (a.title || a.filename).localeCompare(b.title || b.filename); });
            } else if (_sort === 'artist') {
                arr.sort(function (a, b) { return (a.artist || '').localeCompare(b.artist || ''); });
            } else if (_sort === 'duration') {
                arr.sort(function (a, b) { return (a.duration || 0) - (b.duration || 0); });
            } else if (_sort === 'year') {
                arr.sort(function (a, b) { return (a.year || 0) - (b.year || 0); });
            } else if (_sort === 'tuning') {
                arr.sort(function (a, b) { return (a.tuning || '').localeCompare(b.tuning || ''); });
            } else if (_sort === 'added') {
                arr.sort(function (a, b) { return (a.added || 0) - (b.added || 0); });
            }
            if (_sortDir === 'desc') arr.reverse();
            return arr;
        }
        // Lib: read host sort vocabulary (#lib-sort / #v3-songs-sort).
        var v = cfg.getHostSort ? cfg.getHostSort() : '';
        if (!v) return songs;
        var larr = songs.slice();
        if (v === 'artist' || v === 'artist-desc') {
            larr.sort(function (a, b) { return (a.artist || '').localeCompare(b.artist || ''); });
            if (v === 'artist-desc') larr.reverse();
        } else if (v === 'title' || v === 'title-desc') {
            larr.sort(function (a, b) { return (a.title || a.filename).localeCompare(b.title || b.filename); });
            if (v === 'title-desc') larr.reverse();
        } else if (v === 'recent') {
            larr.sort(function (a, b) { return (b.added || 0) - (a.added || 0); });
        } else if (v === 'year-desc') {
            larr.sort(function (a, b) { return (b.year || 0) - (a.year || 0); });
        } else if (v === 'year') {
            larr.sort(function (a, b) { return (a.year || 0) - (b.year || 0); });
        } else if (v === 'tuning') {
            larr.sort(function (a, b) { return (a.tuning || '').localeCompare(b.tuning || ''); });
        }
        return larr;
    }

    // ── Custom modal (Electron blocks prompt/confirm) ───────────────────
    // Self-contained: builds its own DOM and keeps element references in
    // closure (no global ids), so two surface instances never collide.
    var _modalEl    = null;
    var _modalParts = null;
    function _getModal() {
        if (_modalEl && document.body.contains(_modalEl)) return _modalParts;
        _modalEl = document.createElement('div');
        _modalEl.style.cssText = 'display:none; position:fixed; inset:0; z-index:9999; align-items:center; justify-content:center; background:rgba(0,0,0,0.6);';
        var box = document.createElement('div');
        box.style.cssText = 'background:#1f2937; border:1px solid #374151; border-radius:10px; padding:24px; min-width:320px; max-width:480px; box-shadow:0 8px 40px rgba(0,0,0,0.7);';
        var msgEl = document.createElement('div');
        msgEl.style.cssText = 'color:#e5e7eb; font-size:14px; white-space:pre-wrap; margin-bottom:16px; line-height:1.5;';
        var inp = document.createElement('input');
        inp.type = 'text';
        inp.style.cssText = 'display:none; width:100%; background:#111827; border:1px solid #4b5563; border-radius:6px; padding:8px 12px; color:#e5e7eb; font-size:14px; outline:none; box-sizing:border-box; margin-bottom:16px;';
        var btns = document.createElement('div');
        btns.style.cssText = 'display:flex; justify-content:flex-end; gap:8px;';
        var cancelBtn = document.createElement('button');
        cancelBtn.style.cssText = 'padding:7px 18px; border-radius:6px; border:1px solid #374151; background:transparent; color:#9ca3af; font-size:13px; cursor:pointer;';
        cancelBtn.textContent = 'Cancel';
        var okBtn = document.createElement('button');
        okBtn.style.cssText = 'padding:7px 18px; border-radius:6px; border:none; background:#3b82f6; color:#fff; font-size:13px; font-weight:500; cursor:pointer;';
        okBtn.textContent = 'OK';
        btns.appendChild(cancelBtn); btns.appendChild(okBtn);
        box.appendChild(msgEl); box.appendChild(inp); box.appendChild(btns);
        _modalEl.appendChild(box);
        document.body.appendChild(_modalEl);
        _modalParts = { modal: _modalEl, msgEl: msgEl, input: inp, okBtn: okBtn, cancel: cancelBtn };
        return _modalParts;
    }
    function _showModal(message, withInput, defaultVal) {
        return new Promise(function (resolve) {
            var p = _getModal();
            p.msgEl.textContent = message;
            if (withInput) {
                p.input.style.display = 'block';
                p.input.value = defaultVal || '';
                setTimeout(function () { p.input.focus(); p.input.select(); }, 50);
            } else {
                p.input.style.display = 'none';
            }
            p.modal.style.display = 'flex';
            function _done(val) {
                p.modal.style.display = 'none';
                p.okBtn.removeEventListener('click', _ok);
                p.cancel.removeEventListener('click', _cxl);
                p.input.removeEventListener('keydown', _key);
                resolve(val);
            }
            function _ok()  { _done(withInput ? p.input.value.trim() : true); }
            function _cxl() { _done(null); }
            function _key(e) {
                if (e.key === 'Enter')  { e.preventDefault(); _ok(); }
                if (e.key === 'Escape') { e.preventDefault(); _cxl(); }
            }
            p.okBtn.addEventListener('click', _ok);
            p.cancel.addEventListener('click', _cxl);
            if (withInput) p.input.addEventListener('keydown', _key);
        });
    }
    function _confirm(msg)     { return _showModal(msg, false, ''); }
    function _prompt(msg, def) { return _showModal(msg, true,  def || ''); }

    // ── Song card (grid view) ───────────────────────────────────────────
    // ── Preview on hover (opt-in; toggled from the toolbar) ─────────────
    // Streams the song's own audio into a dedicated <audio> element after the
    // pointer dwells briefly (so skimming doesn't blast audio), stopping on
    // leave. Shows an equalizer "now playing" indicator over the art. Never
    // calls playSong or touches the main player's <audio> element.
    var _HOVER_PREVIEW_DELAY_MS = 500;
    var _previewIndHost = null;             // art element currently showing the indicator

    // The backend resolves the correct in-pack audio member (song.audio_member),
    // so we preview with a single request — no probing / 404s. Null = no audio.
    function _previewUrl(song) {
        if (!song || !song.audio_member) return null;
        var enc = song.filename.split('/').map(encodeURIComponent).join('/');
        var mem = song.audio_member.split('/').map(encodeURIComponent).join('/');
        return '/api/sloppak/' + enc + '/file/' + mem;
    }

    function _ensurePreviewStyle() {
        if (document.getElementById('fl-preview-style')) return;
        var st = document.createElement('style');
        st.id = 'fl-preview-style';
        st.textContent =
            '.fl-preview-ind{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);z-index:4;pointer-events:none;}' +
            '.fl-eq{display:flex;align-items:flex-end;gap:2px;height:45%;max-height:22px;opacity:.55;}' +
            '.fl-preview-ind.playing .fl-eq{opacity:1;}' +
            '.fl-eq i{display:block;width:3px;height:25%;background:#60a5fa;border-radius:1px;}' +
            '.fl-preview-ind.playing .fl-eq i{animation:fl-eq-b .8s ease-in-out infinite;}' +
            '.fl-eq i:nth-child(2){animation-delay:.15s;}.fl-eq i:nth-child(3){animation-delay:.3s;}.fl-eq i:nth-child(4){animation-delay:.45s;}' +
            '@keyframes fl-eq-b{0%,100%{height:25%}50%{height:100%}}';
        document.head.appendChild(st);
    }
    function _showIndicator(host) {
        _clearIndicator();
        if (!host) return;
        _ensurePreviewStyle();
        var ind = document.createElement('div');
        ind.className = 'fl-preview-ind';
        ind.innerHTML = '<span class="fl-eq"><i></i><i></i><i></i><i></i></span>';
        host.appendChild(ind);
        _previewIndHost = host;
    }
    function _markIndicatorPlaying() {
        var ind = _previewIndHost && _previewIndHost.querySelector('.fl-preview-ind');
        if (ind) ind.classList.add('playing');
    }
    function _clearIndicator() {
        if (!_previewIndHost) return;
        var ind = _previewIndHost.querySelector('.fl-preview-ind');
        if (ind) ind.remove();
        _previewIndHost = null;
    }

    function _previewEl() {
        if (_previewAudio) return _previewAudio;
        var a = document.createElement('audio');
        a.preload = 'none';
        a.volume  = 0.7;
        _previewAudio = a;
        return a;
    }
    function _stopPreview() {
        _previewSeq++;                       // any pending load/error/playing handler is now stale
        _clearIndicator();
        if (_previewAudio) {
            _previewAudio.onerror = _previewAudio.onloadedmetadata = _previewAudio.onplaying = null;
            try { _previewAudio.pause(); } catch (_) {}
            _previewAudio.removeAttribute('src');
            try { _previewAudio.load(); } catch (_) {}
        }
    }
    function _startPreview(song, host) {
        // Play from 0 — preview.ogg is already a short curated clip, and the
        // full-track fallbacks are fine from the start. (Seeking by a fraction
        // of song.duration broke playback whenever the offset landed past the
        // end of a short preview clip.)
        var url = _previewUrl(song);
        if (!url) return;                    // pack carries no previewable audio
        var a   = _previewEl();
        var seq = ++_previewSeq;
        _showIndicator(host);
        a.onerror         = function () { if (seq === _previewSeq) _clearIndicator(); };
        a.onloadedmetadata = function () { if (seq === _previewSeq) a.play().catch(function () {}); };
        a.onplaying       = function () { if (seq === _previewSeq) _markIndicatorPlaying(); };
        a.src = url;
        a.load();
    }
    function _armHoverPreview(el, song, host) {
        el.addEventListener('mouseenter', function () {
            if (!_previewHover) return;
            clearTimeout(_previewTimer);
            _previewTimer = setTimeout(function () {
                if (_previewHover) _startPreview(song, host);
            }, _HOVER_PREVIEW_DELAY_MS);
        });
        el.addEventListener('mouseleave', function () {
            clearTimeout(_previewTimer);
            _stopPreview();
        });
    }

    function _songCard(song, folderName) {
        var card = document.createElement('div');
        card.className = 'flex flex-col rounded-lg overflow-hidden cursor-pointer group transition-transform duration-100 hover:scale-105';
        card.style.background = '#1a1d2e';
        card.dataset.filename  = song.filename;

        var artWrap = document.createElement('div');
        artWrap.style.cssText = 'position:relative; width:100%; padding-bottom:100%; background:#111827; overflow:hidden;';
        var img = document.createElement('img');
        img.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; object-fit:cover;';
        img.alt = ''; img.loading = 'lazy';
        img.src = '/api/song/' + song.filename.split('/').map(encodeURIComponent).join('/') + '/art';
        var ph = document.createElement('div');
        ph.style.cssText = 'position:absolute; inset:0; display:flex; align-items:center; justify-content:center;';
        ph.innerHTML = '<svg viewBox="0 0 48 48" fill="none" stroke="#374151" stroke-width="1.5" style="width:40px;height:40px"><path d="M6 12a4 4 0 014-4h4l4 4h16a4 4 0 014 4v16a4 4 0 01-4 4H10a4 4 0 01-4-4V12z"/><circle cx="20" cy="26" r="3"/><path d="M23 26v-8l8-2v8"/><circle cx="31" cy="24" r="3"/></svg>';
        img.addEventListener('error', function () { img.style.display = 'none'; ph.style.display = 'flex'; });
        img.addEventListener('load',  function () { ph.style.display = 'none'; });
        artWrap.appendChild(ph); artWrap.appendChild(img);

        if (song.duration != null) {
            var durB = document.createElement('span');
            durB.style.cssText = 'position:absolute; bottom:6px; right:6px; padding:2px 6px; border-radius:4px; font-size:11px; font-weight:600; color:#e5e7eb; background:rgba(0,0,0,0.7);';
            var m0 = Math.floor(song.duration / 60), s0 = String(Math.floor(song.duration % 60)).padStart(2, '0');
            durB.textContent = m0 + ':' + s0;
            artWrap.appendChild(durB);
        }

        var moveBtn = document.createElement('button');
        moveBtn.style.cssText = 'position:absolute; top:6px; right:6px; padding:4px; border-radius:4px; background:rgba(0,0,0,0.6); color:#9ca3af; border:none; cursor:pointer; display:none;';
        moveBtn.title = 'Move to folder…';
        moveBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" style="width:12px;height:12px"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/><path fill-rule="evenodd" d="M10 11a1 1 0 011 1v2h2a1 1 0 110 2h-2v2a1 1 0 11-2 0v-2H7a1 1 0 110-2h2v-2a1 1 0 011-1z" clip-rule="evenodd"/></svg>';
        card.addEventListener('mouseenter', function () { moveBtn.style.display = 'block'; });
        card.addEventListener('mouseleave', function () { moveBtn.style.display = 'none'; });
        moveBtn.addEventListener('click', function (e) { e.stopPropagation(); _moveSong(song, folderName); });
        artWrap.appendChild(moveBtn);

        var meta = document.createElement('div');
        meta.style.cssText = 'padding:8px 10px 10px; flex:1; min-width:0;';
        var title = document.createElement('div');
        title.style.cssText = 'font-size:13px; font-weight:600; color:#e5e7eb; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
        title.textContent = song.title || song.filename;
        var sub = document.createElement('div');
        sub.style.cssText = 'font-size:11px; color:#6b7280; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px;';
        sub.textContent = [song.artist, song.album].filter(Boolean).join(' — ') || '';
        meta.appendChild(title); meta.appendChild(sub);

        if (cfg.songBadges) {
            var cardBadges = _buildSongBadges(song);
            if (cardBadges) {
                meta.appendChild(cardBadges);
                card.addEventListener('mouseenter', function () { _revealBadges(cardBadges); });
                card.addEventListener('mouseleave', function () { _hideBadges(cardBadges); });
            }
            var cardDateInfo = _buildSongDateInfo(song);
            if (cardDateInfo) {
                meta.appendChild(cardDateInfo);
                card.addEventListener('mouseenter', function () { _revealBadges(cardDateInfo); });
                card.addEventListener('mouseleave', function () { _hideBadges(cardDateInfo); });
            }
        }

        card.appendChild(artWrap); card.appendChild(meta);
        card.addEventListener('click', function () {
            if (typeof window.playSong === 'function') window.playSong(song.filename);
        });
        _makeDraggable(card, song, folderName);
        _armHoverPreview(card, song, artWrap);
        return card;
    }

    // ── Song row (list view) ────────────────────────────────────────────
    function _songRow(song, folderName) {
        var row = document.createElement('div');
        row.className = 'flex items-center gap-3 px-3 py-2 rounded cursor-pointer hover:bg-dark-500 group transition-colors duration-100';
        row.dataset.filename = song.filename;

        var thumb = document.createElement('div');
        thumb.style.cssText = 'width:36px; height:36px; border-radius:4px; overflow:hidden; background:#111827; flex-shrink:0; position:relative;';
        var tImg = document.createElement('img');
        tImg.loading = 'lazy';
        tImg.src = '/api/song/' + song.filename.split('/').map(encodeURIComponent).join('/') + '/art';
        tImg.alt = ''; tImg.style.cssText = 'width:100%; height:100%; object-fit:cover;';
        var tPh = document.createElement('div');
        tPh.style.cssText = 'position:absolute; inset:0; display:flex; align-items:center; justify-content:center;';
        tPh.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="#374151" stroke-width="1.5" style="width:14px;height:14px"><path d="M9 19H5a2 2 0 01-2-2V7a2 2 0 012-2h2l2 2h6a2 2 0 012 2v2"/><circle cx="13" cy="16" r="2"/><path d="M15 16v-4l3-1v4"/><circle cx="18" cy="15" r="2"/></svg>';
        tImg.addEventListener('error', function () { tImg.style.display = 'none'; tPh.style.display = 'flex'; });
        tImg.addEventListener('load',  function () { tPh.style.display = 'none'; });
        thumb.appendChild(tPh); thumb.appendChild(tImg);

        var meta = document.createElement('div');
        meta.className = 'flex-1 min-w-0';
        var title = document.createElement('div');
        title.className = 'text-gray-200 truncate group-hover:text-white';
        title.style.cssText = 'font-size:13px; font-weight:600;';
        title.textContent = song.title || song.filename;
        var sub = document.createElement('div');
        sub.className = 'text-gray-500 truncate'; sub.style.fontSize = '11px';
        sub.textContent = [song.artist, song.album].filter(Boolean).join(' — ') || '';
        meta.appendChild(title); meta.appendChild(sub);
        if (cfg.songBadges) {
            var rowBadges = _buildSongBadges(song);
            if (rowBadges) {
                meta.appendChild(rowBadges);
                row.addEventListener('mouseenter', function () { _revealBadges(rowBadges); });
                row.addEventListener('mouseleave', function () { _hideBadges(rowBadges); });
            }
            var rowDateInfo = _buildSongDateInfo(song);
            if (rowDateInfo) {
                meta.appendChild(rowDateInfo);
                row.addEventListener('mouseenter', function () { _revealBadges(rowDateInfo); });
                row.addEventListener('mouseleave', function () { _hideBadges(rowDateInfo); });
            }
        }

        var icon = document.createElement('span');
        icon.className = 'shrink-0 w-4 h-4 text-dark-400 group-hover:text-blue-400 transition-colors opacity-0 group-hover:opacity-100';
        icon.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" class="w-full h-full"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd"/></svg>';

        var dur = document.createElement('span');
        dur.className = 'shrink-0 text-xs text-gray-600 tabular-nums';
        if (song.duration != null) {
            var m1 = Math.floor(song.duration / 60), s1 = String(Math.floor(song.duration % 60)).padStart(2, '0');
            dur.textContent = m1 + ':' + s1;
        }

        var moveBtn = document.createElement('button');
        moveBtn.className = 'shrink-0 p-1 rounded text-gray-600 hover:text-white hover:bg-dark-400 opacity-0 group-hover:opacity-100 transition-opacity';
        moveBtn.title = 'Move to folder…';
        moveBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" style="width:14px;height:14px"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/><path fill-rule="evenodd" d="M10 11a1 1 0 011 1v2h2a1 1 0 110 2h-2v2a1 1 0 11-2 0v-2H7a1 1 0 110-2h2v-2a1 1 0 011-1z" clip-rule="evenodd"/></svg>';
        moveBtn.addEventListener('click', function (e) { e.stopPropagation(); _moveSong(song, folderName); });

        row.appendChild(thumb); row.appendChild(meta); row.appendChild(icon);
        row.appendChild(dur); row.appendChild(moveBtn);
        row.addEventListener('click', function () {
            if (typeof window.playSong === 'function') window.playSong(song.filename);
        });
        _makeDraggable(row, song, folderName);
        _armHoverPreview(row, song, thumb);
        return row;
    }

    // ── Pointer-based drag-and-drop (mousedown/mousemove/mouseup) ───────
    // HTML5 DnD blocks wheel events and gives unreliable edge positions in
    // Electron — pointer events give full control over both.
    var _dragState         = null;
    var _dragCurrentTarget = null;
    var _dragRafId         = null;
    var _DRAG_THRESH = 5, _DRAG_ZONE = 150, _DRAG_SPEED = 50;

    // ── Windowed song lists ─────────────────────────────────────────────
    // A song list used to render EVERY song it held. On a flat 50,944-song
    // library that is one <div> with 50,938 children and ~1.3 MILLION DOM nodes
    // (~25 per row) — ~4.2 GB of renderer RSS, for a screen the user may not
    // even be looking at. It also poisons unrelated code: any
    // `document.querySelector` miss anywhere in the app must walk that whole
    // tree, which is how song_preview's per-frame menu check ended up eating
    // ~50% of the renderer and dropping the app to 2.7 fps (feedBack#965).
    //
    // So render only what is on screen. Rows are uniform height (and grid cards
    // uniform size), so the window is pure arithmetic — no per-row observers.
    // Off-window rows are represented by padding on the list itself rather than
    // spacer elements: a spacer <div> would become a grid ITEM in grid view and
    // shift the columns, whereas padding works identically for both layouts.
    var VIRTUAL_MIN = 200;   // below this, render everything — no behaviour change
    var VIRTUAL_BUFFER = 6;  // rows kept rendered above/below the viewport
    var _virtualCleanups = [];
    var _virtualLists = [];   // repaint fns, one per live windowed list

    // Which slice of the list is on screen. Pure arithmetic — kept separate from
    // the DOM so it can be tested directly (see tests/virtual_list.test.js).
    //
    //   top   : list's offset relative to the scroller viewport's top. NEGATIVE
    //           once the user has scrolled the list's start above the fold.
    //   rows  : total ROWS (grid packs `perRow` songs into one row; list view is 1)
    //
    // Returns the song index range [start, end) to render, plus how many ROWS of
    // padding stand in for the songs above and below it.
    function _visibleWindow(top, viewportH, itemH, perRow, rows, total) {
        if (!(itemH > 0) || !(rows > 0)) return { start: 0, end: total, padRowsTop: 0, padRowsBottom: 0 };
        var firstRow = Math.max(0, Math.floor(-top / itemH) - VIRTUAL_BUFFER);
        var lastRow = Math.min(rows, Math.ceil((-top + viewportH) / itemH) + VIRTUAL_BUFFER);
        // Scrolled entirely past the list (either direction): keep one row alive
        // rather than emptying it, so the padding math stays anchored.
        if (lastRow <= firstRow) {
            firstRow = Math.min(firstRow, rows - 1);
            lastRow = firstRow + 1;
        }
        return {
            start: firstRow * perRow,
            end: Math.min(total, lastRow * perRow),
            padRowsTop: firstRow,
            padRowsBottom: Math.max(0, rows - lastRow),
        };
    }

    function _clearVirtualLists() {
        _virtualCleanups.forEach(function (fn) { try { fn(); } catch (_) {} });
        _virtualCleanups = [];
        _virtualLists = [];
    }

    // Fill `list` with `songs`, windowed when the list is big enough to matter.
    // `make(song)` builds one row/card.
    function _fillSongList(list, songs, make) {
        var sorted = _sortSongs(songs);
        if (sorted.length <= VIRTUAL_MIN) {
            sorted.forEach(function (s) { list.appendChild(make(s)); });
            return;
        }

        var scroller = _getScrollEl();
        var basePadTop = parseFloat(window.getComputedStyle(list).paddingTop) || 0;
        var basePadBot = parseFloat(window.getComputedStyle(list).paddingBottom) || 0;

        // Measure one real row once — no hardcoded row height to drift out of
        // sync with the CSS. (The list is shown before it is populated, so this
        // measures a laid-out row, not a zero-height one.)
        var probe = make(sorted[0]);
        probe.style.visibility = 'hidden';
        list.appendChild(probe);
        var probeRect = probe.getBoundingClientRect();
        var rowH = probeRect.height || 44;
        var cardW = probeRect.width || 150;
        list.removeChild(probe);

        var GRID_GAP = 12;   // matches the grid's `gap:12px`
        var raf = 0, lastStart = -1, lastEnd = -1;

        // Recomputed on EVERY paint, not captured once: a window resize changes
        // the grid's column count, and therefore the row count and the height of
        // the padding standing in for off-window rows. paint() runs on resize, so
        // stale metrics would slice the wrong songs and mis-size the list.
        function metrics() {
            var perRow = 1, itemH = rowH;
            if (_view === 'grid') {
                perRow = Math.max(1, Math.floor((list.clientWidth + GRID_GAP) / (cardW + GRID_GAP)));
                itemH = rowH + GRID_GAP;
            }
            return { perRow: perRow, itemH: itemH, rows: Math.ceil(sorted.length / perRow) };
        }

        function paint() {
            raf = 0;
            // Collapsed (display:none) or detached: nothing to paint, and don't
            // pay for layout on every scroll tick of a section nobody can see.
            // Forget the last window so re-showing repaints from scratch against
            // the new position rather than short-circuiting on a stale memo.
            if (!list.isConnected || list.offsetParent === null) {
                lastStart = -1; lastEnd = -1;
                return;
            }
            var m = metrics();
            // Where the list sits relative to the scroller's viewport.
            var top = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
            var vh = scroller.clientHeight || window.innerHeight;
            var w = _visibleWindow(top, vh, m.itemH, m.perRow, m.rows, sorted.length);
            if (w.start === lastStart && w.end === lastEnd) return;   // nothing moved
            lastStart = w.start; lastEnd = w.end;

            var frag = document.createDocumentFragment();
            for (var i = w.start; i < w.end; i++) frag.appendChild(make(sorted[i]));
            list.textContent = '';
            list.style.paddingTop = (basePadTop + w.padRowsTop * m.itemH) + 'px';
            list.style.paddingBottom = (basePadBot + w.padRowsBottom * m.itemH) + 'px';
            list.appendChild(frag);
        }
        function schedule() { if (!raf) raf = window.requestAnimationFrame(paint); }

        scroller.addEventListener('scroll', schedule, { passive: true });
        window.addEventListener('resize', schedule);
        // Expanding or collapsing ANY section moves every list below it. Those
        // lists' windows are computed from their position, so they must repaint
        // too — otherwise they keep the window from their old position and show
        // blank padding where songs should be until the user happens to scroll.
        _virtualLists.push(schedule);
        _virtualCleanups.push(function () {
            scroller.removeEventListener('scroll', schedule);
            window.removeEventListener('resize', schedule);
            if (raf) window.cancelAnimationFrame(raf);
        });
        paint();
    }

    // Re-window every live list — call after anything that can move them
    // vertically (a folder expanding/collapsing, a section being shown).
    function _repaintVirtualLists() {
        _virtualLists.forEach(function (fn) { try { fn(); } catch (_) {} });
    }

    function _getScrollEl() {
        var el = _treeEl();
        while (el && el !== document.documentElement) {
            var ov = window.getComputedStyle(el).overflowY;
            if ((ov === 'auto' || ov === 'scroll' || ov === 'overlay') && el.scrollHeight > el.clientHeight) return el;
            el = el.parentElement;
        }
        return document.scrollingElement || document.documentElement;
    }
    function _dragFindTarget(x, y) {
        var els = document.elementsFromPoint(x, y);
        for (var i = 0; i < els.length; i++) {
            if ('dropFolder' in (els[i].dataset || {})) return els[i];
        }
        return null;
    }
    function _dragHighlight(target) {
        if (_dragCurrentTarget === target) return;
        if (_dragCurrentTarget) _dragCurrentTarget.style.outline = '';
        _dragCurrentTarget = target;
        if (target) { target.style.outline = '2px solid #3b82f6'; target.style.borderRadius = '6px'; }
    }
    function _dragScrollTick() {
        if (!_dragState || !_dragState.live) { _dragRafId = null; return; }
        var h = window.innerHeight, y = _dragState.y;
        var sc = _getScrollEl();
        sc.style.scrollBehavior = 'auto';
        if (y < _DRAG_ZONE)          sc.scrollTop -= _DRAG_SPEED;
        else if (y > h - _DRAG_ZONE) sc.scrollTop += _DRAG_SPEED;
        _dragRafId = requestAnimationFrame(_dragScrollTick);
    }
    function _onDragMove(e) {
        if (!_dragState) return;
        _dragState.x = e.clientX; _dragState.y = e.clientY;
        if (!_dragState.live) {
            var dx = _dragState.x - _dragState.startX, dy = _dragState.y - _dragState.startY;
            if (Math.sqrt(dx * dx + dy * dy) < _DRAG_THRESH) return;
            _dragState.live = true;
            var ghost = document.createElement('div');
            ghost.style.cssText = 'position:fixed; pointer-events:none; z-index:9999; padding:5px 12px; background:#1e2130; border:1px solid #3b82f6; border-radius:6px; color:#e5e7eb; font-size:12px; white-space:nowrap; box-shadow:0 4px 20px rgba(0,0,0,0.5);';
            ghost.textContent = _dragState.data.label;
            document.body.appendChild(ghost);
            _dragState.ghost = ghost;
            if (!_dragRafId) _dragRafId = requestAnimationFrame(_dragScrollTick);
        }
        if (_dragState.ghost) {
            _dragState.ghost.style.left = (_dragState.x + 14) + 'px';
            _dragState.ghost.style.top  = (_dragState.y + 14) + 'px';
        }
        _dragHighlight(_dragFindTarget(_dragState.x, _dragState.y));
    }
    function _onDragUp(e) {
        if (!_dragState) return;
        var wasDrag = _dragState.live, data = _dragState.data;
        var x = e.clientX, y = e.clientY;
        _endDrag();
        if (wasDrag) {
            // Suppress the click that fires after mouseup so the song doesn't play.
            document.addEventListener('click', function (ce) {
                ce.stopPropagation(); ce.preventDefault();
            }, { capture: true, once: true });
            var target = _dragFindTarget(x, y);
            if (target && data) {
                var tf = target.dataset.dropFolder;
                if (tf !== data.folder) _executeDrop(data, tf);
            }
        }
    }
    function _onDragKey(e) { if (e.key === 'Escape') _endDrag(); }
    function _endDrag() {
        if (_dragRafId) { cancelAnimationFrame(_dragRafId); _dragRafId = null; }
        if (_dragState && _dragState.ghost) _dragState.ghost.remove();
        if (_dragCurrentTarget) { _dragCurrentTarget.style.outline = ''; _dragCurrentTarget = null; }
        document.body.style.userSelect = '';
        _dragState = null;
        document.removeEventListener('mousemove', _onDragMove);
        document.removeEventListener('mouseup', _onDragUp);
        document.removeEventListener('keydown', _onDragKey);
    }
    async function _executeDrop(data, targetFolder) {
        // No optimistic tree mutation — the drag ghost gives instant visual
        // feedback, and racing optimistic updates against _load() caused songs
        // to snap back when dropping quickly in succession.
        if (targetFolder !== '') _openFolders.add(targetFolder);
        else _unsortedOpen = true;
        try {
            await _api('/song/move', { filename: data.filename, folder: targetFolder });
        } catch (err) {
            _status('Move failed: ' + err.message, true);
        }
        await _load(true);
    }
    function _makeDraggable(el, song, folderName) {
        el.style.cursor = 'grab';
        el.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            document.body.style.userSelect = 'none';
            var sel = window.getSelection(); if (sel) sel.removeAllRanges();
            _dragState = {
                data: { filename: song.filename, folder: folderName || '', label: '↕  ' + (song.title || song.filename) },
                startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY,
                live: false, ghost: null,
            };
            document.addEventListener('mousemove', _onDragMove);
            document.addEventListener('mouseup', _onDragUp);
            document.addEventListener('keydown', _onDragKey);
        });
        el.addEventListener('dragstart', function (e) { e.preventDefault(); });
    }
    function _makeDropTarget(el, tf) {
        el.dataset.dropFolder = (tf == null) ? '' : tf;
    }

    // ── Move song dialog ────────────────────────────────────────────────
    async function _moveSong(song, currentFolderPath) {
        if (!_tree) return;
        var allPaths = [];
        function _collect(f) { allPaths.push(f.path); (f.children || []).forEach(_collect); }
        _tree.folders.forEach(_collect);
        var options = ['(Unsorted)'].concat(allPaths.filter(function (p) { return p !== currentFolderPath; }));
        var choice  = await _prompt(
            'Move "' + (song.title || song.filename) + '" to:\n' +
            options.map(function (n, i) { return i + ': ' + n; }).join('\n') +
            '\n\nEnter number or folder path:', ''
        );
        if (!choice && choice !== 0) return;
        var dest = '', idx = parseInt(choice, 10);
        if (!isNaN(idx) && idx >= 0 && idx < options.length) {
            dest = idx === 0 ? '' : options[idx];
        } else {
            dest = choice.trim() === '(Unsorted)' ? '' : choice.trim();
        }
        try {
            await _api('/song/move', { filename: song.filename, folder: dest });
            await _load(true);
        } catch (err) { await _prompt('Move failed: ' + err.message, ''); }
    }

    // ── Folder section ──────────────────────────────────────────────────
    function _folderSection(folder, depth) {
        depth = depth || 0;
        var q    = _query();
        var open = q ? true : _openFolders.has(folder.path);
        var wrap = document.createElement('div');

        function _countDeep(f) {
            var n = f.songs.length;
            (f.children || []).forEach(function (c) { n += _countDeep(c); });
            return n;
        }
        function _countFoldersDeep(f) {
            var n = (f.children || []).length;
            (f.children || []).forEach(function (c) { n += _countFoldersDeep(c); });
            return n;
        }

        var hdr = document.createElement('div');
        hdr.className = 'flex items-center gap-2 px-3 py-2 rounded cursor-pointer group';
        hdr.style.transition = 'background-color 0.1s';

        var chev = document.createElement('span');
        chev.className = 'shrink-0 w-4 h-4 text-gray-500 transition-transform duration-150';
        chev.style.transform = open ? 'rotate(90deg)' : '';
        chev.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" class="w-full h-full"><path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd"/></svg>';

        var ico = document.createElement('span');
        ico.className = 'shrink-0 w-4 h-4 ' + (depth > 0 ? 'text-yellow-600' : 'text-yellow-500');
        ico.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" class="w-full h-full"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/></svg>';

        var lbl = document.createElement('span');
        lbl.className = 'flex-1 truncate font-medium ' + (depth > 0 ? 'text-xs text-gray-400' : 'text-sm text-gray-200');
        lbl.textContent = folder.name;

        var cnt = document.createElement('span');
        if (cfg.deepFolderCount) {
            // Lib: deep song + subfolder summary ("N songs · M subfolders").
            var _deepTotal = _countDeep(folder);
            var _subCount  = _countFoldersDeep(folder);
            cnt.style.cssText = 'flex-shrink:0; font-size:12px; margin-right:4px; color:#6b7280;';
            var _cntText = _deepTotal + ' song' + (_deepTotal === 1 ? '' : 's');
            if (_subCount > 0) _cntText += ' · ' + _subCount + ' subfolder' + (_subCount === 1 ? '' : 's');
            cnt.textContent = _cntText;
        } else {
            // Nav: direct song count only.
            cnt.className = 'shrink-0 text-xs text-gray-600 tabular-nums mr-1';
            cnt.textContent = String(folder.songs.length);
        }

        var subBtn = document.createElement('button');
        subBtn.className = 'shrink-0 p-1 rounded text-gray-600 hover:text-white hover:bg-dark-400';
        subBtn.title = 'New subfolder';
        subBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" style="width:14px;height:14px"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/><path fill-rule="evenodd" d="M10 11a1 1 0 011 1v2h2a1 1 0 110 2h-2v2a1 1 0 11-2 0v-2H7a1 1 0 110-2h2v-2a1 1 0 011-1z" clip-rule="evenodd"/></svg>';
        subBtn.addEventListener('click', function (e) { e.stopPropagation(); _createFolder(folder.path); });

        var renameBtn = document.createElement('button');
        renameBtn.className = 'shrink-0 p-1 rounded text-gray-600 hover:text-white hover:bg-dark-400';
        renameBtn.title = 'Rename folder';
        renameBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" style="width:14px;height:14px"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/></svg>';
        renameBtn.addEventListener('click', function (e) { e.stopPropagation(); _renameFolder(folder.path); });

        var delBtn = document.createElement('button');
        delBtn.className = 'shrink-0 p-1 rounded text-gray-600 hover:text-red-400 hover:bg-dark-400';
        delBtn.title = 'Delete folder';
        delBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" style="width:14px;height:14px"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>';
        delBtn.addEventListener('click', function (e) { e.stopPropagation(); _deleteFolder(folder.path, _countDeep(folder), _countFoldersDeep(folder)); });

        var expandChildBtn   = document.createElement('button');
        var collapseChildBtn = document.createElement('button');
        if (folder.children && folder.children.length) {
            expandChildBtn.className = 'shrink-0 p-1 rounded text-gray-600 hover:text-white hover:bg-dark-400';
            expandChildBtn.title = 'Expand all subfolders';
            expandChildBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" style="width:14px;height:14px"><path d="M5 8l5 5 5-5"/><path d="M5 4l5 5 5-5" opacity=".4"/></svg>';
            expandChildBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                _openFolders.add(folder.path);
                (folder.children || []).forEach(function (c) { _openFolders.add(c.path); });
                _storeJSON('open', [..._openFolders]); _render();
            });
            collapseChildBtn.className = 'shrink-0 p-1 rounded text-gray-600 hover:text-white hover:bg-dark-400';
            collapseChildBtn.title = 'Collapse all subfolders';
            collapseChildBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" style="width:14px;height:14px"><path d="M5 12l5-5 5 5"/><path d="M5 16l5-5 5 5" opacity=".4"/></svg>';
            collapseChildBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                (folder.children || []).forEach(function (c) { _openFolders.delete(c.path); });
                _storeJSON('open', [..._openFolders]); _render();
            });
        }

        // Collapsing button group — 0 width when hidden, slides in on hover.
        var btnGroup = document.createElement('div');
        btnGroup.style.cssText = 'display:flex; align-items:center; gap:2px; max-width:0; overflow:hidden; transition:max-width 0.2s ease;';
        if (folder.children && folder.children.length) {
            btnGroup.appendChild(expandChildBtn); btnGroup.appendChild(collapseChildBtn);
        }
        btnGroup.appendChild(subBtn); btnGroup.appendChild(renameBtn); btnGroup.appendChild(delBtn);

        // mouseover (bubbles) + stopPropagation so only the innermost folder activates.
        wrap.style.cssText = 'border-radius:6px; margin:1px 0;';
        wrap.addEventListener('mouseover', function (e) {
            if (_dragState) return;
            e.stopPropagation();
            if (_hoveredFolder && _hoveredFolder.wrap !== wrap) {
                _hoveredFolder.hdr.style.backgroundColor = '';
                _hoveredFolder.wrap.style.backgroundColor = '';
                _hoveredFolder.btnGroup.style.maxWidth = '0';
            }
            _hoveredFolder = { wrap: wrap, hdr: hdr, btnGroup: btnGroup };
            hdr.style.backgroundColor  = 'rgba(55,65,81,0.5)';
            wrap.style.backgroundColor = 'rgba(55,65,81,0.12)';
            btnGroup.style.maxWidth = '160px';
        });
        wrap.addEventListener('mouseout', function (e) {
            if (_dragState) return;
            if (wrap.contains(e.relatedTarget)) return;
            hdr.style.backgroundColor = ''; wrap.style.backgroundColor = '';
            btnGroup.style.maxWidth = '0';
            if (_hoveredFolder && _hoveredFolder.wrap === wrap) _hoveredFolder = null;
        });

        // cnt sits after btnGroup so it rests at the far right when buttons hidden.
        hdr.appendChild(chev); hdr.appendChild(ico); hdr.appendChild(lbl);
        hdr.appendChild(btnGroup); hdr.appendChild(cnt);
        _makeDropTarget(hdr, folder.path);

        var content = document.createElement('div');
        if (!open) content.style.display = 'none';

        var list = document.createElement('div');
        if (_view === 'grid') {
            list.style.cssText = 'display:grid; grid-template-columns:repeat(auto-fill,150px); justify-content:start; gap:12px; padding:8px 4px 8px 24px;';
        } else {
            list.className = 'ml-5 mt-0.5 space-y-0';
        }
        _makeDropTarget(list, folder.path);

        var childrenWrap = document.createElement('div');
        // Suppress grid padding on empty song lists — prevents a blank amber stub.
        if (_view === 'grid' && !folder.songs.length) list.style.padding = '0';

        var _listPopulated = open;
        function _populateList() {
            _fillSongList(list, folder.songs, function (s) {
                return _view === 'grid' ? _songCard(s, folder.path) : _songRow(s, folder.path);
            });
            (folder.children || []).forEach(function (child) {
                childrenWrap.appendChild(_folderSection(child, depth + 1));
            });
        }
        if (open) _populateList();

        // depth > 0: one container with a continuous amber border-left grouping
        // songs + child folders. depth == 0: children indent, root songs unbordered.
        var innerWrap = null;
        if (depth > 0) {
            innerWrap = document.createElement('div');
            innerWrap.style.cssText = 'margin-left:32px; padding-left:10px; border-left:2px solid rgba(234,179,8,0.35);';
            innerWrap.appendChild(list); innerWrap.appendChild(childrenWrap);
            content.appendChild(innerWrap);
        } else {
            childrenWrap.style.marginLeft = '32px';
            content.appendChild(list); content.appendChild(childrenWrap);
        }

        content.addEventListener('click', function (e) {
            if (_query()) return;
            var bgEls = [content, list, childrenWrap];
            if (innerWrap) bgEls.push(innerWrap);
            if (bgEls.indexOf(e.target) === -1) return;
            if (content.style.display !== 'none') {
                content.style.display = 'none'; chev.style.transform = '';
                _openFolders.delete(folder.path); _storeJSON('open', [..._openFolders]);
            }
        });

        hdr.addEventListener('click', function () {
            if (_query()) return;
            var nowOpen = content.style.display === 'none';
            // Show BEFORE populating: a windowed list measures a real row and the
            // scroller viewport, and both are zero while display:none.
            content.style.display = nowOpen ? '' : 'none';
            if (nowOpen && !_listPopulated) { _populateList(); _listPopulated = true; }
            chev.style.transform  = nowOpen ? 'rotate(90deg)' : '';
            if (nowOpen) _openFolders.add(folder.path);
            else         _openFolders.delete(folder.path);
            _storeJSON('open', [..._openFolders]);
            // This toggle moved everything below it — re-window the other lists,
            // and re-window THIS one if it was already populated (its saved
            // window was computed at its old position).
            _repaintVirtualLists();
        });

        wrap.appendChild(hdr); wrap.appendChild(content);
        return wrap;
    }

    // ── Unsorted section ────────────────────────────────────────────────
    function _unsortedSection(songs) {
        var q = _query();
        if (!songs.length && q) return null;
        var wrap = document.createElement('div');
        wrap.className = 'mb-1';

        var hdr = document.createElement('div');
        hdr.className = 'flex items-center gap-2 px-3 py-2 rounded cursor-pointer hover:bg-dark-500 transition-colors duration-100';

        var chev = document.createElement('span');
        chev.className = 'shrink-0 w-4 h-4 text-gray-600 transition-transform duration-150';
        chev.style.transform = _unsortedOpen ? 'rotate(90deg)' : '';
        chev.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" class="w-full h-full"><path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd"/></svg>';

        var ico = document.createElement('span');
        ico.className = 'shrink-0 w-4 h-4 text-gray-600';
        ico.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" class="w-full h-full"><path d="M2 6a2 2 0 012-2h12a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/></svg>';

        var lbl = document.createElement('span');
        lbl.className = 'flex-1 text-xs font-semibold uppercase tracking-widest text-gray-600';
        lbl.textContent = 'Unsorted';

        var cnt = document.createElement('span');
        cnt.className = 'shrink-0 text-xs text-gray-700 tabular-nums';
        cnt.textContent = String(songs.length);

        hdr.appendChild(chev); hdr.appendChild(ico); hdr.appendChild(lbl); hdr.appendChild(cnt);
        _makeDropTarget(hdr, '');

        var list = document.createElement('div');
        if (_view === 'grid') {
            list.style.cssText = 'display:grid; grid-template-columns:repeat(auto-fill,150px); justify-content:start; gap:12px; padding:8px 4px 8px 24px;';
        } else {
            list.className = 'ml-5 mt-0.5 space-y-0';
        }
        var _populated = _unsortedOpen;
        function _populate() {
            _fillSongList(list, songs, function (s) {
                return _view === 'grid' ? _songCard(s, '') : _songRow(s, '');
            });
        }
        if (_unsortedOpen) { _populate(); } else { list.style.display = 'none'; }
        _makeDropTarget(list, '');

        hdr.addEventListener('click', function () {
            if (_query()) return;
            _unsortedOpen = list.style.display === 'none';
            // Show BEFORE populating — see the folder toggle above.
            list.style.display = _unsortedOpen ? (_view === 'grid' ? 'grid' : '') : 'none';
            if (_unsortedOpen && !_populated) { _populate(); _populated = true; }
            chev.style.transform = _unsortedOpen ? 'rotate(90deg)' : '';
            _store(cfg.unsortedKey, String(_unsortedOpen));
            _repaintVirtualLists();   // this toggle moved every list below it
        });

        wrap.appendChild(hdr); wrap.appendChild(list);
        return wrap;
    }

    // ── Folder management ───────────────────────────────────────────────
    async function _createFolder(parentPath) {
        var msg = parentPath ? 'New subfolder name in "' + parentPath.split('/').pop() + '":' : 'New folder name:';
        var name = await _prompt(msg);
        if (!name || !name.trim()) return;
        try {
            var body = { name: name.trim() };
            if (parentPath) body.parent = parentPath;
            await _api('/folder/create', body);
            var newPath = parentPath ? parentPath + '/' + name.trim() : name.trim();
            if (parentPath) _openFolders.add(parentPath);
            _openFolders.add(newPath);
            await _load(true);
        } catch (err) { await _prompt('Create failed: ' + err.message); }
    }
    async function _renameFolder(folderPath) {
        var oldName = folderPath.split('/').pop();
        var newName = await _prompt('Rename "' + oldName + '" to:', oldName);
        if (!newName || !newName.trim() || newName.trim() === oldName) return;
        try {
            await _api('/folder/rename', { old: folderPath, new: newName.trim() });
            var parts = folderPath.split('/');
            parts[parts.length - 1] = newName.trim();
            var newPath = parts.join('/');
            var updated = new Set();
            _openFolders.forEach(function (p) {
                if (p === folderPath) updated.add(newPath);
                else if (p.startsWith(folderPath + '/')) updated.add(newPath + p.slice(folderPath.length));
                else updated.add(p);
            });
            _openFolders = updated;
            _storeJSON('open', [..._openFolders]);
            await _load(true);
        } catch (err) { await _prompt('Rename failed: ' + err.message); }
    }
    async function _deleteFolder(folderPath, songCount, folderCount) {
        var folderName = folderPath.split('/').pop();
        var parts = [];
        if (songCount   > 0) parts.push(songCount   + ' song'      + (songCount   === 1 ? '' : 's'));
        if (folderCount > 0) parts.push(folderCount + ' subfolder' + (folderCount === 1 ? '' : 's'));
        var msg = parts.length
            ? 'Delete "' + folderName + '"? It contains ' + parts.join(' and ') + '. Songs will be moved to Unsorted.'
            : 'Delete empty folder "' + folderName + '"?';
        var ok = await _confirm(msg);
        if (!ok) return;
        try {
            await _api('/folder/delete', { name: folderPath });
            var toDelete = [];
            _openFolders.forEach(function (p) {
                if (p === folderPath || p.startsWith(folderPath + '/')) toDelete.push(p);
            });
            toDelete.forEach(function (p) { _openFolders.delete(p); });
            _storeJSON('open', [..._openFolders]);
            await _load(true);
        } catch (err) { await _prompt('Delete failed: ' + err.message); }
    }

    // ── Expand / collapse all ───────────────────────────────────────────
    function _expandAll() {
        if (!_tree) return;
        function _addPaths(f) { _openFolders.add(f.path); (f.children || []).forEach(_addPaths); }
        _tree.folders.forEach(_addPaths);
        _unsortedOpen = true;
        _storeJSON('open', [..._openFolders]); _store(cfg.unsortedKey, 'true');
        _render();
    }
    function _collapseAll() {
        _openFolders.clear(); _unsortedOpen = false;
        _storeJSON('open', []); _store(cfg.unsortedKey, 'false');
        _render();
    }

    // ── Render ──────────────────────────────────────────────────────────
    function _render() {
        _hoveredFolder = null; // DOM is rebuilt; discard any stale reference
        // Drop the scroll listeners of the previous render's windowed lists —
        // their `list` nodes are about to be detached, and a surviving listener
        // would keep painting into orphaned DOM (and leak on every re-render).
        _clearVirtualLists();
        var treeEl = _treeEl();
        if (!treeEl) return;
        var data = _filtered();
        var frag = document.createDocumentFragment();
        var unsorted = _unsortedSection(data.root_songs);
        if (unsorted) frag.appendChild(unsorted);
        data.folders.forEach(function (f) { frag.appendChild(_folderSection(f)); });
        if (!data.folders.length && !data.root_songs.length) {
            var emp = document.createElement('div');
            emp.className = 'flex flex-col items-center justify-center py-24 gap-3 text-gray-700';
            emp.innerHTML = '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" class="w-12 h-12"><path d="M6 12a4 4 0 014-4h8l4 4h16a4 4 0 014 4v20a4 4 0 01-4 4H10a4 4 0 01-4-4V12z"/></svg>' +
                '<p class="text-sm">' + (_query() ? 'No songs match your search.' : 'No songs found.') + '</p>';
            frag.appendChild(emp);
        }
        treeEl.innerHTML = ''; treeEl.appendChild(frag);

        // Lib: update the library count line ("N songs · M folders").
        if (cfg.countId) {
            var countEl = _el(cfg.countId);
            if (countEl) {
                var total = data.root_songs.length;
                var folderCount = 0;
                function _countDeep(f) {
                    total += f.songs.length;
                    folderCount += 1;
                    (f.children || []).forEach(_countDeep);
                }
                data.folders.forEach(_countDeep);
                var songStr   = total + ' song' + (total === 1 ? '' : 's');
                var folderStr = folderCount + ' folder' + (folderCount === 1 ? '' : 's');
                countEl.textContent = songStr + ' · ' + folderStr;
            }
        }
    }

    // ── Toolbar injection (lib surface, once) ───────────────────────────
    function _injectToolbar() {
        if (_toolbarDone) return;
        var ctrl = _el(cfg.controlsId);
        if (!ctrl) {
            ctrl = document.createElement('div');
            ctrl.id = cfg.controlsId;
            var treeEl = _treeEl();
            if (!treeEl) return;
            treeEl.parentNode.insertBefore(ctrl, treeEl);
        }
        ctrl.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:12px;';
        ctrl.innerHTML = '';

        var viewGroup = document.createElement('div');
        viewGroup.style.cssText = 'display:flex; background:#1f2937; border:1px solid #374151; border-radius:10px; overflow:hidden;';
        var listBtn = document.createElement('button');
        listBtn.title = 'List view';
        listBtn.style.cssText = 'padding:7px 10px; border:none; cursor:pointer; transition:background 0.1s, color 0.1s;';
        listBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor" style="width:14px;height:14px;display:block;"><rect x="1" y="1" width="14" height="3" rx="1"/><rect x="3" y="6" width="12" height="3" rx="1"/><rect x="3" y="11" width="12" height="3" rx="1"/></svg>';
        var gridBtn = document.createElement('button');
        gridBtn.title = 'Grid view';
        gridBtn.style.cssText = 'padding:7px 10px; border:none; cursor:pointer; transition:background 0.1s, color 0.1s;';
        gridBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor" style="width:14px;height:14px;display:block;"><rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/><rect x="1" y="9" width="6" height="6" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>';
        function _applyViewBtns() {
            listBtn.style.background = _view === 'list' ? '#374151' : 'transparent';
            listBtn.style.color      = _view === 'list' ? '#e5e7eb' : '#6b7280';
            gridBtn.style.background = _view === 'grid' ? '#374151' : 'transparent';
            gridBtn.style.color      = _view === 'grid' ? '#e5e7eb' : '#6b7280';
        }
        _applyViewBtns();
        listBtn.addEventListener('click', function () {
            if (_view === 'list') return;
            _view = 'list'; _store('view', 'list'); _applyViewBtns(); _render();
        });
        gridBtn.addEventListener('click', function () {
            if (_view === 'grid') return;
            _view = 'grid'; _store('view', 'grid'); _applyViewBtns(); _render();
        });
        viewGroup.appendChild(listBtn); viewGroup.appendChild(gridBtn);

        var newBtn = _makeToolbarBtn(
            '<svg viewBox="0 0 20 20" fill="currentColor" style="width:14px;height:14px;flex-shrink:0"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/><path fill-rule="evenodd" d="M10 11a1 1 0 011 1v2h2a1 1 0 110 2h-2v2a1 1 0 11-2 0v-2H7a1 1 0 110-2h2v-2a1 1 0 011-1z" clip-rule="evenodd"/></svg>',
            null, 'New parent folder'
        );
        newBtn.addEventListener('click', function () { _createFolder(); });
        var expBtn = _makeToolbarBtn(
            '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" style="width:14px;height:14px"><path d="M5 8l5 5 5-5"/><path d="M5 4l5 5 5-5" opacity=".4"/></svg>',
            null, 'Expand all'
        );
        expBtn.addEventListener('click', _expandAll);
        var colBtn = _makeToolbarBtn(
            '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" style="width:14px;height:14px"><path d="M5 12l5-5 5 5"/><path d="M5 16l5-5 5 5" opacity=".4"/></svg>',
            null, 'Collapse all'
        );
        colBtn.addEventListener('click', _collapseAll);

        // Preview-on-hover toggle (persisted per surface via cfg.storePrefix)
        var previewBtn = document.createElement('button');
        previewBtn.style.cssText = 'display:flex; align-items:center; gap:6px; padding:7px 12px; border:1px solid #374151; border-radius:10px; cursor:pointer; font-size:13px; white-space:nowrap; transition:color 0.1s, background 0.1s, border-color 0.1s;';
        previewBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" style="width:14px;height:14px"><path d="M6 4l10 6-10 6V4z"/></svg>';
        function _applyPreviewBtn() {
            previewBtn.style.background  = _previewHover ? '#1d4ed8' : '#1f2937';
            previewBtn.style.color       = _previewHover ? '#ffffff' : '#9ca3af';
            previewBtn.style.borderColor = _previewHover ? '#3b82f6' : '#374151';
            previewBtn.title = 'Preview on hover: ' + (_previewHover ? 'on' : 'off');
        }
        _applyPreviewBtn();
        previewBtn.addEventListener('click', function () {
            _previewHover = !_previewHover;
            _store('previewHover', _previewHover ? 'true' : 'false');
            if (!_previewHover) { clearTimeout(_previewTimer); _stopPreview(); }
            _applyPreviewBtn();
        });

        ctrl.appendChild(viewGroup);
        ctrl.appendChild(newBtn);
        ctrl.appendChild(expBtn);
        ctrl.appendChild(colBtn);
        ctrl.appendChild(previewBtn);

        _toolbarDone = true;
    }
    function _makeToolbarBtn(iconHtml, label, title) {
        var btn = document.createElement('button');
        btn.title = title || '';
        btn.style.cssText = 'display:flex; align-items:center; gap:6px; padding:7px 12px; background:#1f2937; border:1px solid #374151; border-radius:10px; color:#9ca3af; cursor:pointer; font-size:13px; white-space:nowrap; transition:color 0.1s, border-color 0.1s;';
        btn.innerHTML = iconHtml + (label ? '<span>' + label + '</span>' : '');
        btn.addEventListener('mouseenter', function () { btn.style.color = '#e5e7eb'; btn.style.borderColor = '#6b7280'; });
        btn.addEventListener('mouseleave', function () { btn.style.color = '#9ca3af'; btn.style.borderColor = '#374151'; });
        return btn;
    }

    // ── Unload (lib surface) ────────────────────────────────────────────
    function _unload() {
        _clearVirtualLists();   // don't leave scroll listeners behind on teardown
        _stopPreview();         // silence any in-progress hover preview
        if (!cfg.searchInputId) return;
        var el = _el(cfg.searchInputId);
        if (el) el.style.maxWidth = '';
    }

    // ── Init (nav surface) ──────────────────────────────────────────────
    function _init() {
        _closeDropdown();
        _fixHeight();
        window.addEventListener('resize', _fixHeight);

        var search      = _el('fb-search');
        var reload      = _el('fb-reload');
        var expandAll   = _el('fb-expand-all');
        var collapseAll = _el('fb-collapse-all');
        var newFolder   = _el('fb-new-folder');
        var filterBtn   = _el('fb-filter');
        var filterBack  = _el('fb-filter-backdrop');
        var viewList    = _el('fb-view-list');
        var viewGrid    = _el('fb-view-grid');

        if (!search) return;

        search.style.position = 'relative';
        search.style.zIndex   = '100';

        function _updateViewButtons() {
            if (!viewList || !viewGrid) return;
            viewList.style.color = _view === 'list' ? '#ffffff' : '';
            viewList.style.background = _view === 'list' ? '#1f2937' : '';
            viewGrid.style.color = _view === 'grid' ? '#ffffff' : '';
            viewGrid.style.background = _view === 'grid' ? '#1f2937' : '';
        }
        _updateViewButtons();
        if (viewList) viewList.addEventListener('click', function () {
            if (_view === 'list') return;
            _view = 'list'; _store('view', 'list'); _updateViewButtons(); _render();
        });
        if (viewGrid) viewGrid.addEventListener('click', function () {
            if (_view === 'grid') return;
            _view = 'grid'; _store('view', 'grid'); _updateViewButtons(); _render();
        });

        var sortSel    = _el('fb-sort');
        var sortDirBtn = _el('fb-sort-dir');
        var sortDirIco = _el('fb-sort-dir-icon');
        function _updateSortDir() {
            if (!sortDirBtn) return;
            var isAsc = _sortDir === 'asc';
            var active = _sort !== 'default';
            sortDirBtn.title = isAsc ? 'Ascending' : 'Descending';
            sortDirBtn.style.opacity = active ? '' : '0.35';
            sortDirBtn.style.cursor  = active ? '' : 'default';
            if (sortDirIco) {
                sortDirIco.innerHTML = isAsc
                    ? '<path d="M5 12l5-5 5 5"/>'
                    : '<path d="M5 8l5 5 5-5"/>';
            }
        }
        _updateSortDir();
        if (sortSel) {
            sortSel.value = _sort;
            sortSel.addEventListener('change', function () {
                _sort = sortSel.value; _store('sort', _sort); _updateSortDir(); _render();
            });
        }
        if (sortDirBtn) {
            sortDirBtn.addEventListener('click', function () {
                if (_sort === 'default') return;
                _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
                _store('sortDir', _sortDir); _updateSortDir(); _render();
            });
        }

        search.addEventListener('input', function () { _render(); });
        search.addEventListener('click', function (e) { e.stopPropagation(); _closeDropdown(); });

        reload.addEventListener('click', function () { _loaded = false; _load(true); });
        expandAll.addEventListener('click', _expandAll);
        collapseAll.addEventListener('click', _collapseAll);
        newFolder.addEventListener('click', function () { _createFolder(); });
        if (filterBtn)  filterBtn.addEventListener('click', _openFilterPanel);
        if (filterBack) filterBack.addEventListener('click', _closeFilterPanel);
        _updateFilterBadge();

        if (!_loaded) _load(true);
    }

    // ── Screen changed (nav surface) ────────────────────────────────────
    function _onScreenChanged(ev) {
        var id = ev && ev.detail && ev.detail.id;
        if (id === cfg.screenId) {
            _closeDropdown();
            if (!_loaded) _load(true);
        }
    }

    return {
        load: _load,
        unload: _unload,
        init: _init,
        onScreenChanged: _onScreenChanged,
        render: _render,
        // Pure window arithmetic, exposed for tests (no DOM needed).
        __test: { visibleWindow: _visibleWindow, VIRTUAL_MIN: VIRTUAL_MIN, VIRTUAL_BUFFER: VIRTUAL_BUFFER },
    };
}

// ════════════════════════════════════════════════════════════════════════
//  Surface configs
// ════════════════════════════════════════════════════════════════════════
var NAV_CONFIG = {
    apiBase:        API,
    storePrefix:    'fo:',
    treeId:         'fb-tree',
    screenId:       'plugin-folder_library',
    unsortedKey:    'unsorted_open',
    ownsStatus:     true,
    ownsFilterPanel:true,
    ownsSort:       true,
    songBadges:     true,
    deepFolderCount:false,
    autoExpandTop:  false,
    injectToolbar:  false,
    getSearchEl:    function () { return document.getElementById('fb-search'); },
};

var LIB_CONFIG = {
    apiBase:        API,
    storePrefix:    'fo:lib:',
    treeId:         'lib-folder-tree',
    controlsId:     'lib-folder-controls',
    countId:        'lib-count',
    searchInputId:  'lib-filter',
    unsortedKey:    'unsorted',
    ownsStatus:     false,
    ownsFilterPanel:false,
    ownsSort:       false,
    songBadges:     false,
    deepFolderCount:true,
    autoExpandTop:  true,
    injectToolbar:  true,
    getSearchEl:    function () { return document.getElementById('v3-search') || document.getElementById('lib-filter'); },
    getFilterParams: function () {
        return (typeof window.v3Songs?.filterParams === 'function')
            ? window.v3Songs.filterParams()
            : (typeof window.feedBackLibFilterParams === 'function')
            ? window.feedBackLibFilterParams()
            : (typeof window.slopsmithLibFilterParams === 'function')
            ? window.slopsmithLibFilterParams() : '';
    },
    getHostArtist:  function () { return (typeof window.v3Songs?.getArtist === 'function') ? window.v3Songs.getArtist() : ''; },
    getHostAlbum:   function () { return (typeof window.v3Songs?.getAlbum  === 'function') ? window.v3Songs.getAlbum()  : ''; },
    getHostSort:    function () {
        return (typeof window.v3Songs?.getSort === 'function')
            ? window.v3Songs.getSort()
            : (document.getElementById('lib-sort') || document.getElementById('v3-songs-sort') || {}).value || '';
    },
};

// ════════════════════════════════════════════════════════════════════════
//  Adapter A — v2 nav screen (renders into #fb-tree)
// ════════════════════════════════════════════════════════════════════════
if (!window.__folderLibraryNavLoaded) {
    window.__folderLibraryNavLoaded = true;
    var _nav = createFolderSurface(NAV_CONFIG);

    if (window.feedBack && typeof window.feedBack.on === 'function') {
        window.feedBack.on('screen:changed', _nav.onScreenChanged);
    } else if (window.slopsmith && typeof window.slopsmith.on === 'function') {
        window.slopsmith.on('screen:changed', _nav.onScreenChanged);
    } else {
        var _deadline = performance.now() + 5000;
        var _pollId = setInterval(function () {
            var bus = window.feedBack || window.slopsmith;
            if (bus && typeof bus.on === 'function') {
                clearInterval(_pollId);
                bus.on('screen:changed', _nav.onScreenChanged);
            } else if (performance.now() > _deadline) {
                clearInterval(_pollId);
            }
        }, 100);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _nav.init, { once: true });
    } else {
        _nav.init();
    }
}

// ════════════════════════════════════════════════════════════════════════
//  Adapter B — v3 library view (window.folderLibrary, renders into #lib-folder-tree)
// ════════════════════════════════════════════════════════════════════════
// Idempotency: the factory instance is a persistent singleton (so its in-memory
// state survives a script re-injection), but window.folderLibrary is ALWAYS
// (re)assigned on every evaluation — the host's reload path does
// `delete window.folderLibrary` and re-injects this script expecting it back.
if (!window.__folderLibraryLib) {
    window.__folderLibraryLib = createFolderSurface(LIB_CONFIG);
}
(function () {
    var _lib = window.__folderLibraryLib;

    window.folderLibrary = {
        load:   function (force) { return _lib.load(force); },
        unload: function ()      { _lib.unload(); },
        __test: _lib.__test,
    };

    // Auto-load if folder view was already active when this script was injected.
    // On a hard refresh, setLibView() runs before plugins load, so
    // window.folderLibrary didn't exist yet and the host's load call silently
    // skipped. Now that we're defined, kick off the load if #lib-folder-tree is
    // currently visible.
    var treeEl = document.getElementById('lib-folder-tree');
    if (treeEl && !treeEl.classList.contains('hidden')) {
        _lib.load();
    }
}());

})();
