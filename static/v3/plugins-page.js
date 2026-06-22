/*
 * fee[dB]ack v0.3.0 — Plugins page (#v3-plugins), "Pedalboard" layout.
 *
 * Plugins are grouped by category onto guitar-pedalboard surfaces; each plugin
 * renders as a stompbox pedal (thumbnail + name + short description). Pedals are
 * free-form draggable within their board (positions persist in localStorage),
 * and decorative patch cables (pedal-cables.js) sag/swing between them. Clicking
 * (not dragging) a pedal opens that plugin's SETTINGS page; plugins with no
 * settings fall back to their screen. Data comes from the enriched /api/plugins
 * (now carrying description/category/icon — see plugins/__init__.py::_nav_entry).
 * The bundled Capability Inspector still owns the live capability graph; we
 * surface a deep-link to it rather than rebuilding it.
 */
(function () {
    'use strict';
    var sm = window.slopsmith;
    var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

    var LS_KEY = 'v3.pedalboard.layout';
    var DEFAULT_THUMB = '/static/v3/pedal-default.svg';

    // Pool of pedal "skin" photos (static/v3/pedals/). Each plugin is assigned
    // one at random on first sight and keeps it across sessions (persisted in
    // localStorage). Add more by dropping files here and listing them.
    var FRAMES_KEY = 'v3.pedalboard.frames';
    var PEDAL_FRAMES = [
        'pedal-001.png', 'pedal-002.png', 'pedal-003.png', 'pedal-004.png', 'pedal-005.png',
        'pedal-006.png', 'pedal-007.png', 'pedal-008.png', 'pedal-009.png', 'pedal-010.png',
        'pedal-011.png', 'pedal-012.png', 'pedal-013.png', 'pedal-014.png', 'pedal-015.png',
        'pedal-016.png', 'pedal-017.png', 'pedal-018.png', 'pedal-019.png',
    ];
    // Bump when the skin images change on disk — busts the browser cache so the
    // new artwork shows without a manual hard-reload (filenames are reused).
    var FRAMES_VERSION = 8;

    // Recursively re-home parsed JSON onto NULL-prototype objects, so manifest-
    // controlled keys (category / plugin id) like '__proto__' / 'toString' /
    // 'constructor' — at ANY nesting level — resolve to undefined instead of an
    // inherited member (the layout map nests category → id → {x,y}).
    function _nullProto(o) {
        if (!o || typeof o !== 'object') return o;
        if (Array.isArray(o)) return o.map(_nullProto);
        var out = Object.create(null);
        for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = _nullProto(o[k]);
        return out;
    }
    function _loadMap(key) {
        try {
            var r = window.localStorage.getItem(key);
            var o = r ? JSON.parse(r) : null;
            return (o && typeof o === 'object' && !Array.isArray(o)) ? _nullProto(o) : Object.create(null);
        } catch (e) { return Object.create(null); }
    }
    function loadFrames() { return _loadMap(FRAMES_KEY); }
    function saveFrames(o) { try { window.localStorage.setItem(FRAMES_KEY, JSON.stringify(o)); } catch (e) { /* */ } }
    function pickFrame() { return PEDAL_FRAMES.length ? PEDAL_FRAMES[Math.floor(Math.random() * PEDAL_FRAMES.length)] : null; }
    // Return the persisted skin for a plugin, assigning (and recording into
    // `frames`) a fresh random one if absent or no longer in the pool.
    function frameFor(id, frames) {
        var f = frames[id];
        if (!f || PEDAL_FRAMES.indexOf(f) === -1) { f = pickFrame(); if (f) frames[id] = f; }
        return f;
    }
    function frameUrl(f) { return f ? '/static/v3/pedals/' + f + '?v=' + FRAMES_VERSION : '/static/v3/pedal-frame.svg'; }

    // Persisted collapsed state per board (category → true when collapsed).
    var COLLAPSE_KEY = 'v3.pedalboard.collapsed';
    function loadCollapsed() { return _loadMap(COLLAPSE_KEY); }
    function saveCollapsed(o) { try { window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(o)); } catch (e) { /* */ } }

    // Board order + human labels. Only non-empty boards render.
    var BOARD_ORDER = ['audio', 'creation', 'practice', 'game', 'tools', 'other'];
    // Null-prototype lookup maps: keys are manifest-controlled (category / plugin
    // id), so `BOARD_LABEL[cat]` / `CURATED[id]` must not resolve inherited members
    // for keys like '__proto__' / 'toString' / 'constructor'.
    var BOARD_LABEL = Object.assign(Object.create(null), {
        audio: 'Audio', creation: 'Creation', practice: 'Practice',
        game: 'Games', tools: 'Tools', other: 'Other',
    });

    // Curated plugin-id → category map. Keyed on loader ids (which differ from
    // repo names, e.g. midi_amp / rig_builder / note_detect). A manifest
    // `category` overrides this; unknown ids fall through to deriveFromType then
    // 'other'. Tune freely — it only affects which board a pedal sits on.
    var CURATED = Object.assign(Object.create(null), {
        // audio — tone / amp / stems
        nam_tone: 'audio', rig_builder: 'audio', nam_rig_builder: 'audio',
        stems: 'audio', stem_mixer: 'audio', midi_amp: 'audio', midi: 'audio',
        tones: 'audio', note_detect: 'audio', notedetect: 'audio', backingtrack: 'audio',
        tuner: 'audio',
        // creation — highways / visualizers / authoring
        highway_3d: 'creation', drum_highway_3d: 'creation', drums: 'creation',
        piano: 'creation', jumpingtab: 'creation', invert_highway: 'creation',
        splitscreen: 'creation', studio: 'creation', multiplayer: 'creation',
        // practice — drills / theory / reference
        metronome: 'practice', practice_journal: 'practice', practice: 'practice',
        section_map: 'practice', sectionmap: 'practice', stepmode: 'practice',
        guitar_theory: 'practice', fretboard: 'practice', tabview: 'practice',
        lyrics_karaoke: 'practice', chordgem: 'practice', player_guide: 'practice',
        the_daily: 'practice', tutorials: 'practice', virtuoso: 'practice',
        // games
        flappy_bend: 'game', minigames: 'game', chord_sprint: 'game',
        // tools — import / manage / utility
        editor: 'tools', tabimport: 'tools', sloppak_converter: 'tools',
        profileimport: 'tools', find_more: 'tools', themes: 'tools',
        update_manager: 'tools', song_preview: 'tools', setlist: 'tools',
        transpose_chords: 'tools', discextract: 'tools', rs1extract: 'tools',
        loosefolder: 'tools', cf: 'tools',
    });

    function deriveFromType(p) {
        if (p && p.type === 'visualization') return 'creation';
        return null;
    }

    function categoryOf(p) {
        // A manifest `category` is authoritative (an unknown value just becomes
        // its own board, rendered after the known ones). Otherwise fall back to
        // the curated id map, then a type-derived guess, then 'other'.
        if (p && typeof p.category === 'string' && p.category.trim()) return p.category.trim().toLowerCase();
        return (p && CURATED[p.id]) || deriveFromType(p) || 'other';
    }

    function thumbUrl(p) {
        if (p && typeof p.icon === 'string' && p.icon) {
            var rel = p.icon.replace(/^assets\//, '');
            return '/api/plugins/' + encodeURIComponent(p.id) + '/assets/' + encodeURI(rel);
        }
        return DEFAULT_THUMB;
    }

    function openable(p) {
        // A plugin's screen is openable only if a #plugin-<id> screen exists
        // (declared via nav/has_screen, or already injected by a script plugin).
        return !!(p.nav || p.has_screen || (p.has_script && document.getElementById('plugin-' + p.id)));
    }

    // Decide what a pedal click should open: its settings panel, else its
    // screen, else nothing (toast). Pure — unit-tested.
    function settingsTarget(p) {
        if (p && p.has_settings) return { kind: 'settings', id: p.id };
        if (openable(p)) return { kind: 'screen', id: p.id };
        return { kind: 'none', id: p && p.id };
    }

    // ---- layout persistence (pure-ish, tested) ----------------------------

    function loadLayout() { return _loadMap(LS_KEY); }
    function saveLayout(obj) {
        try { window.localStorage.setItem(LS_KEY, JSON.stringify(obj)); } catch (e) { /* quota / private mode */ }
    }
    function clampToBoard(pos, boardW, pedalW) {
        var maxX = Math.max(0, boardW - pedalW);
        var x = Math.min(Math.max(0, pos.x || 0), maxX);
        var y = Math.max(0, pos.y || 0);
        return { x: x, y: y };
    }

    // The column count adapts to the board width so pedals stay near TARGET_W
    // (more columns on a wide window, fewer when narrow); their pixel width is
    // then computed to fill the row evenly. GAP_X must exceed 2×PLUG_BOOT
    // (pedal-cables.js) so facing plugs leave room for cable. Height = width /
    // PEDAL_ASPECT.
    var TARGET_W = 220, PEDAL_ASPECT = 0.6, PAD = 24, GAP_X = 96, GAP_Y = 40;
    function pedalDims(boardW) {
        var cols = Math.max(1, Math.round((boardW - PAD * 2 + GAP_X) / (TARGET_W + GAP_X)));
        var w = Math.max(120, Math.floor((boardW - PAD * 2 - (cols - 1) * GAP_X) / cols));
        return { w: w, h: Math.round(w / PEDAL_ASPECT), cols: cols };
    }
    // Default flow slot for the Nth pedal on a board of width boardW.
    // GAP_X must exceed 2×PLUG_BOOT (pedal-cables.js) so two facing side-jack
    // plugs leave room for a visible cable between adjacent pedals. PEDAL_W/H
    // must match .v3-pedal's rendered size in v3.css.
    function defaultSlot(index, boardW) {
        var d = pedalDims(boardW);
        var col = index % d.cols, row = Math.floor(index / d.cols);
        return { x: PAD + col * (d.w + GAP_X), y: PAD + row * (d.h + GAP_Y) };
    }

    // ---- rendering --------------------------------------------------------

    function statusPill(p) {
        var s = p.status || 'ready';
        if (s === 'failed') return '<span class="v3-pedal-pill v3-pill-bad">Failed</span>';
        if (s === 'installing') return '<span class="v3-pedal-pill v3-pill-wait">Installing</span>';
        return '';
    }

    function pedalHtml(p) {
        var failed = p.status === 'failed';
        var desc = p.description || '';
        // The skin photo (knobs, footswitch, jacks all baked in) is the card
        // background; the plugin's identity overlays in a label panel.
        // Skin goes on a CSS var so it lives on the ::before layer (which dims
        // when disabled) while the glow ring stays full-colour.
        var style = p._frameUrl ? ' style="--skin:url(\'' + esc(p._frameUrl) + '\')"' : '';
        var off = p.enabled === false;
        // Description shows only as a hover tooltip on the pedal, not on the face.
        var tip = (p.name || p.id) + (desc ? ' — ' + desc : '');
        return '<div class="v3-pedal' + (off ? ' v3-pedal-off' : '') + '" data-id="' + esc(p.id) + '" tabindex="0" role="button" ' +
            'aria-label="' + esc(p.name || p.id) + ' — open settings" title="' + esc(tip) + '"' + style + '>' +
            '<span class="v3-pedal-glow" aria-hidden="true"></span>' +
            (p.bundled ? '<span class="v3-pedal-bundled" title="Ships with Slopsmith core">core</span>' : '') +
            '<span class="v3-pedal-offbadge" aria-hidden="true">off</span>' +
            '<div class="v3-pedal-label">' +
            '<img class="v3-pedal-thumb" alt="" loading="lazy" src="' + esc(thumbUrl(p)) + '">' +
            '<div class="v3-pedal-name">' + esc(p.name || p.id) + '</div>' +
            statusPill(p) +
            (failed && p.error ? '<div class="v3-pedal-err">' + esc(p.error) + '</div>' : '') +
            '</div>' +
            // Footswitch hotspot — clicking toggles the plugin on/off (does NOT
            // open settings). Positioned over the photo's stomp button.
            '<button class="v3-pedal-foot" data-foot="' + esc(p.id) + '" ' +
            'title="Turn this plugin on/off" aria-label="Toggle ' + esc(p.name || p.id) + '"></button>' +
            '</div>';
    }

    function boardHtml(cat, list, collapsed) {
        var ec = esc(cat);   // category can come from a plugin manifest → escape it
        return '<section class="v3-board-section' + (collapsed ? ' collapsed' : '') + '" data-category="' + ec + '">' +
            '<button class="v3-board-title" data-toggle="' + ec + '" aria-expanded="' + (!collapsed) + '">' +
            '<svg class="v3-board-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">' +
            '<path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>' +
            '<span>' + esc(BOARD_LABEL[cat] || cat) + '</span>' +
            '<span class="v3-board-count">' + list.length + '</span></button>' +
            '<div class="v3-pedalboard" data-category="' + ec + '">' +
            list.map(pedalHtml).join('') +
            '</div></section>';
    }

    function toast(msg) {
        var host = document.getElementById('v3-plugins-toast');
        if (!host) {
            host = document.createElement('div');
            host.id = 'v3-plugins-toast';
            host.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 z-[120] bg-fb-card text-fb-text ' +
                'border border-fb-border/60 rounded-lg px-4 py-2 text-sm shadow-xl';
            document.body.appendChild(host);
        }
        host.textContent = msg;
        host.classList.remove('hidden');
        clearTimeout(host._t);
        host._t = setTimeout(function () { host.classList.add('hidden'); }, 3000);
    }

    // Open a plugin's settings panel: switch to the legacy Settings screen (it
    // mounts each plugin's settings.html as a <details data-plugin-id> under
    // #plugin-settings — app.js), then expand + scroll to it. Retries a few
    // frames in case the details haven't hydrated yet.
    function openSettingsPanel(id, tries) {
        var t = tries == null ? 12 : tries;
        // Match by iterating (not an interpolated selector) so an unusual plugin
        // id with quotes/brackets can't break querySelector or inject a selector.
        var d = null, all = document.querySelectorAll('#plugin-settings details[data-plugin-id]');
        for (var i = 0; i < all.length; i++) { if (all[i].getAttribute('data-plugin-id') === id) { d = all[i]; break; } }
        if (d) {
            d.open = true;
            try { d.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { d.scrollIntoView(); }
            return;
        }
        if (t > 0) requestAnimationFrame(function () { openSettingsPanel(id, t - 1); });
    }

    function openPluginSettings(p) {
        var tgt = settingsTarget(p);
        if (tgt.kind === 'settings') {
            if (window.showScreen) window.showScreen('settings');
            openSettingsPanel(tgt.id);
        } else if (tgt.kind === 'screen') {
            // Only navigate if the screen is actually mounted — an installing/
            // failed plugin has manifest has_screen but no #plugin-<id> div yet.
            if (window.showScreen && document.getElementById('plugin-' + tgt.id)) {
                window.showScreen('plugin-' + tgt.id);
            } else {
                toast('This plugin is still loading — try again in a moment.');
            }
        } else {
            toast('This plugin has no settings or screen to open.');
        }
    }

    // Footswitch enable/disable with "last intent wins": clicks set pedal._want
    // (the desired enabled state) + an optimistic class; one request is in flight
    // at a time, and if the user's intent changed while it ran we resend, so the
    // final state always matches the latest click (no stale-response overwrite).
    function flushFoot(pedal, id) {
        pedal._pending = true;
        var sending = pedal._want;
        fetch('/api/plugins/' + encodeURIComponent(id) + '/enabled', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: sending }),
        }).then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
          .then(function (res) {
              if (pedal._plugin) pedal._plugin.enabled = res.enabled;   // last known server state
              if (pedal._want !== res.enabled) { flushFoot(pedal, id); return; }   // intent changed → resend
              pedal.classList.toggle('v3-pedal-off', res.enabled === false);
              pedal._pending = false;
          })
          .catch(function () {
              pedal._pending = false;
              // revert optimistic UI to the last known-good server state
              var known = pedal._plugin ? pedal._plugin.enabled !== false : true;
              pedal._want = known;
              pedal.classList.toggle('v3-pedal-off', !known);
              toast('Could not toggle this plugin.');
          });
    }

    // Position every pedal on a board from saved layout (clamped) or default
    // flow, and grow the board to fit. Mutates the DOM.
    function layoutBoard(boardEl, cat, layout) {
        var boardW = boardEl.clientWidth || boardEl.offsetWidth || 800;
        var d = pedalDims(boardW);
        var pedals = boardEl.querySelectorAll('.v3-pedal');
        var saved = layout && layout[cat];
        if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = Object.create(null);
        var maxBottom = 0;
        for (var i = 0; i < pedals.length; i++) {
            var el = pedals[i];
            var id = el.getAttribute('data-id');
            el.style.width = d.w + 'px';
            el.style.height = d.h + 'px';
            var pos = saved[id] ? clampToBoard(saved[id], boardW, d.w) : defaultSlot(i, boardW);
            el.style.left = pos.x + 'px';
            el.style.top = pos.y + 'px';
            maxBottom = Math.max(maxBottom, pos.y + d.h);
        }
        boardEl.style.minHeight = (maxBottom + PAD) + 'px';
    }

    var DRAG_THRESHOLD = 5;

    function wirePedalDrag(boardEl, cat) {
        var boardW = function () { return boardEl.clientWidth || 800; };
        boardEl.querySelectorAll('.v3-pedal').forEach(function (el) {
            var startX = 0, startY = 0, origX = 0, origY = 0, dragging = false;

            el.addEventListener('pointerdown', function (ev) {
                if (ev.button != null && ev.button !== 0) return;
                startX = ev.clientX; startY = ev.clientY;
                origX = parseFloat(el.style.left) || 0;
                origY = parseFloat(el.style.top) || 0;
                dragging = false;
                // Clear any stale suppression flag from a prior drag that wasn't
                // followed by a click (some browsers skip click after capture).
                el._dragged = false;
                try { el.setPointerCapture(ev.pointerId); } catch (e) { /* */ }
            });

            el.addEventListener('pointermove', function (ev) {
                if (el.hasPointerCapture && !el.hasPointerCapture(ev.pointerId)) return;
                var dx = ev.clientX - startX, dy = ev.clientY - startY;
                if (!dragging && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
                if (!dragging) {
                    dragging = true;
                    el.classList.add('v3-pedal-dragging');
                    if (window.v3PedalCables) window.v3PedalCables.setDragging(true);
                }
                var bw = boardW(); var d = pedalDims(bw);
                var pos = clampToBoard({ x: origX + dx, y: origY + dy }, bw, d.w);
                el.style.left = pos.x + 'px';
                el.style.top = pos.y + 'px';
                // Grow board to fit if dragged below current extent.
                var need = pos.y + d.h + PAD;
                if (need > (parseFloat(boardEl.style.minHeight) || 0)) boardEl.style.minHeight = need + 'px';
                if (window.v3PedalCables) window.v3PedalCables.refresh();
            });

            function endDrag(ev) {
                if (el.hasPointerCapture && ev && ev.pointerId != null) {
                    try { el.releasePointerCapture(ev.pointerId); } catch (e) { /* */ }
                }
                if (dragging) {
                    el.classList.remove('v3-pedal-dragging');
                    el._dragged = true; // suppress the click that follows
                    var layout = loadLayout();
                    var bucket = layout[cat];
                    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) {
                        bucket = layout[cat] = Object.create(null);
                    }
                    bucket[el.getAttribute('data-id')] = {
                        x: parseFloat(el.style.left) || 0,
                        y: parseFloat(el.style.top) || 0,
                    };
                    saveLayout(layout);
                    if (window.v3PedalCables) window.v3PedalCables.setDragging(false);
                }
                dragging = false;
            }
            el.addEventListener('pointerup', endDrag);
            el.addEventListener('pointercancel', endDrag);

            // Click / keyboard activate → open settings, unless a drag just ran.
            el.addEventListener('click', function () {
                if (el._dragged) { el._dragged = false; return; }
                if (el._plugin) openPluginSettings(el._plugin);
            });
            el.addEventListener('keydown', function (ev) {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    if (el._plugin) openPluginSettings(el._plugin);
                }
            });
        });
    }

    async function render() {
        var root = document.getElementById('v3-plugins');
        if (!root) return;
        var plugins = [];
        try { var r = await fetch('/api/plugins'); if (r.ok) plugins = await r.json(); } catch (e) { /* */ }
        if (!Array.isArray(plugins)) plugins = [];
        var active = plugins.filter(function (p) { return (p.status || 'ready') === 'ready'; }).length;
        var inspectorPresent = plugins.some(function (p) { return p.id === 'capability_inspector'; });

        // Assign each plugin its persisted (or freshly-random) pedal skin.
        var frames = loadFrames();
        plugins.forEach(function (p) { p._frameUrl = frameUrl(frameFor(p.id, frames)); });
        saveFrames(frames);

        // Group by category. Null-prototype map so a manifest category like
        // '__proto__' / 'toString' / 'constructor' resolves to undefined (not an
        // inherited member) and can't crash the grouping.
        var byCat = Object.create(null);
        plugins.forEach(function (p) {
            var c = categoryOf(p);
            (byCat[c] = byCat[c] || []).push(p);
        });
        var cats = BOARD_ORDER.filter(function (c) { return byCat[c] && byCat[c].length; });
        // Any unexpected category not in BOARD_ORDER → append after.
        Object.keys(byCat).forEach(function (c) { if (cats.indexOf(c) === -1) cats.push(c); });

        var collapsed = loadCollapsed();
        var boardsHtml = cats.map(function (c) { return boardHtml(c, byCat[c], !!collapsed[c]); }).join('');

        root.innerHTML =
            '<div class="v3-pedalboards-wrap px-6 md:px-8 pb-10">' +
            '<div class="flex items-center justify-between gap-3 mb-6 flex-wrap">' +
            '<span class="text-lg font-medium text-fb-good">' + active + ' active</span>' +
            '<div class="flex items-center gap-2">' +
            '<button id="v3-pedal-reset" class="text-sm bg-fb-card/60 hover:bg-fb-card border border-fb-border/50 text-fb-textDim hover:text-fb-text px-3 py-1.5 rounded-md" title="Reset pedal positions and re-roll skins">Reset</button>' +
            (inspectorPresent
                ? '<button id="v3-open-inspector" class="text-sm bg-fb-card/60 hover:bg-fb-card border border-fb-border/50 text-fb-text px-3 py-1.5 rounded-md">Capability Inspector →</button>'
                : '') +
            '</div></div>' +
            (boardsHtml || '<p class="text-fb-textDim text-sm">No plugins installed.</p>') +
            '</div>';

        // Bind plugin objects to pedal elements + lay them out + wire drag.
        var byId = Object.create(null);
        plugins.forEach(function (p) { byId[p.id] = p; });
        var layout = loadLayout();
        root.querySelectorAll('.v3-pedalboard').forEach(function (boardEl) {
            var cat = boardEl.getAttribute('data-category');
            boardEl.querySelectorAll('.v3-pedal').forEach(function (el) {
                el._plugin = byId[el.getAttribute('data-id')];
            });
            layoutBoard(boardEl, cat, layout);
            wirePedalDrag(boardEl, cat);
        });
        // Thumbnail fallback on load error.
        root.querySelectorAll('.v3-pedal-thumb').forEach(function (img) {
            img.addEventListener('error', function () {
                if (img.src.indexOf(DEFAULT_THUMB) === -1) img.src = DEFAULT_THUMB;
            }, { once: true });
        });

        // Cables overlay (decorative). Re-attach since render() rebuilt the DOM.
        // Only run the loop if the plugins screen is actually visible — render()
        // also fires at boot while #v3-plugins is hidden, and screen:changed in
        // pedal-cables.js handles activation on later navigation.
        if (window.v3PedalCables) {
            window.v3PedalCables.attach(root);
            window.v3PedalCables.markActive(root.classList.contains('active'));
        }

        // Collapsible boards: toggle on title click, persist per category.
        root.querySelectorAll('[data-toggle]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var cat = btn.getAttribute('data-toggle');
                var sec = btn.closest('.v3-board-section');
                if (!sec) return;
                var nowCollapsed = !sec.classList.contains('collapsed');
                sec.classList.toggle('collapsed', nowCollapsed);
                btn.setAttribute('aria-expanded', String(!nowCollapsed));
                var c = loadCollapsed();
                if (nowCollapsed) c[cat] = true; else delete c[cat];
                saveCollapsed(c);
                // While collapsed the board is display:none, so its pedals were
                // laid out against a 0-width board. Re-flow on expand now that it
                // has a real width.
                if (!nowCollapsed) {
                    var board = sec.querySelector('.v3-pedalboard');
                    if (board) layoutBoard(board, cat, loadLayout());
                }
                if (window.v3PedalCables) window.v3PedalCables.refresh();
            });
        });

        // Footswitch → enable/disable the plugin (POST /api/plugins/<id>/enabled).
        // stopPropagation so it neither starts a drag nor opens settings.
        root.querySelectorAll('[data-foot]').forEach(function (btn) {
            btn.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
            btn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                var id = btn.getAttribute('data-foot');
                var pedal = btn.closest('.v3-pedal');
                if (!pedal) return;
                var desired = pedal.classList.contains('v3-pedal-off');  // off → want enabled
                pedal.classList.toggle('v3-pedal-off', !desired);        // optimistic
                pedal._want = desired;
                // A request already running will reconcile to the new _want when
                // it returns; otherwise start one.
                if (!pedal._pending) flushFoot(pedal, id);
            });
        });

        var reset = root.querySelector('#v3-pedal-reset');
        if (reset) reset.addEventListener('click', function () {
            // Clear saved positions AND skin assignments so both re-roll.
            try { window.localStorage.removeItem(LS_KEY); window.localStorage.removeItem(FRAMES_KEY); } catch (e) { /* */ }
            render();
        });
        var insp = root.querySelector('#v3-open-inspector');
        if (insp) insp.addEventListener('click', function () {
            if (window.showScreen && document.getElementById('plugin-capability_inspector')) {
                window.showScreen('plugin-capability_inspector');
            }
        });
    }

    window.v3PluginsPage = {
        render: render,
        // Pure helpers exposed for unit tests.
        _test: {
            categoryOf: categoryOf, thumbUrl: thumbUrl, settingsTarget: settingsTarget,
            clampToBoard: clampToBoard, defaultSlot: defaultSlot,
            loadLayout: loadLayout, saveLayout: saveLayout,
            frameFor: frameFor, pickFrame: pickFrame, frameUrl: frameUrl,
            loadCollapsed: loadCollapsed, saveCollapsed: saveCollapsed, COLLAPSE_KEY: COLLAPSE_KEY,
            DRAG_THRESHOLD: DRAG_THRESHOLD, LS_KEY: LS_KEY, CURATED: CURATED,
            BOARD_ORDER: BOARD_ORDER, PEDAL_FRAMES: PEDAL_FRAMES, FRAMES_KEY: FRAMES_KEY,
        },
    };
    if (sm && typeof sm.on === 'function') {
        sm.on('screen:changed', function (e) { if (e && e.detail && e.detail.id === 'v3-plugins') render(); });
    }

    // Re-flow the boards when the window resizes (responsive pedal width) — only
    // while the Plugins screen is visible, throttled to one frame.
    function relayoutAll() {
        var root = document.getElementById('v3-plugins');
        if (!root || !root.classList.contains('active')) return;
        var layout = loadLayout();
        root.querySelectorAll('.v3-pedalboard').forEach(function (boardEl) {
            layoutBoard(boardEl, boardEl.getAttribute('data-category'), layout);
        });
        if (window.v3PedalCables) window.v3PedalCables.refresh();
    }
    var _resizePending = false;
    window.addEventListener('resize', function () {
        if (_resizePending) return;
        _resizePending = true;
        requestAnimationFrame(function () { _resizePending = false; relayoutAll(); });
    }, { passive: true });

    function boot() { render(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();
