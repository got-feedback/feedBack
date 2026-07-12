// The visualization layer — the viz picker, renderer selection, and Auto-match.
//
// Carved verbatim out of static/app.js (R3a). A LEAF module: it imports NOTHING,
// which is what lets static/js/plugin-loader.js take _populateVizPicker straight
// from here and drop the configurePluginLoader() host seam it needed while this
// code still lived in app.js.
//
// It owns the state behind those decisions (the one-shot WebGL2 probe, the
// 3D-promotion flag, the Auto label, the notation-hint memo) — all
// module-private, because nothing outside reads them.

// ── Visualization picker (feedBack#36) ─────────────────────────────────
//
// Discovers viz plugins via /api/plugins and adds them to the #viz-picker
// dropdown. A viz plugin declares itself by setting `"type": "visualization"`
// in its plugin.json AND exposing a factory function on
// window.feedBackViz_<id> that returns an object matching the setRenderer
// contract ({init, draw, resize, destroy}).
//
// The "default" option in the dropdown is the built-in 2D highway that
// lives inside createHighway(); selecting it calls setRenderer(null) which
// restores the default renderer. The bundled 3D Highway plugin
// (plugins/highway_3d/) registers as id `highway_3d` and is the new
// fresh-install default per feedBack#160 PR 3.

// ── WebGL2 detection (one-shot probe) ────────────────────────────────────
// 3D Highway requires WebGL2. On environments where it's unavailable
// (older browsers, some embedded webviews, software-only contexts), we
// silently fall back to the Classic 2D Highway and flash a single toast
// so the user knows why their highway looks different. Cached so we don't
// thrash the GPU with repeat throwaway-canvas creations.
let _webgl2Probe = null;
function _canRun3D() {
    if (_webgl2Probe !== null) return _webgl2Probe;
    try {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl2');
        _webgl2Probe = !!gl;
        // Lose the context immediately — the probe canvas is never reused.
        if (gl && gl.getExtension) {
            const ext = gl.getExtension('WEBGL_lose_context');
            if (ext && ext.loseContext) ext.loseContext();
        }
    } catch (_) { _webgl2Probe = false; }
    return _webgl2Probe;
}

// ── Migration / nag flags ────────────────────────────────────────────────
// `feedBack_3d_promoted_v1` is set the first time we auto-flip an existing
// `vizSelection='default'` user to `'highway_3d'`. Persistence ensures we
// don't re-nag on every reload — and ensures the WebGL2 fallback path
// doesn't ping-pong (one fallback toast, not one per page load).
const _3D_PROMOTED_FLAG_KEY = 'feedBack_3d_promoted_v1';
function _markPromoted() {
    try { localStorage.setItem(_3D_PROMOTED_FLAG_KEY, '1'); } catch (_) {}
}
function _hasPromotedFlag() {
    try { return localStorage.getItem(_3D_PROMOTED_FLAG_KEY) === '1'; }
    catch (_) { return false; }
}

// Pending nag: queued during _populateVizPicker, fired on the first
// `song:ready` (so the toast lands when the user actually opens the
// player, not at page load when they're still in the library).
// `song:ready` is emitted by window.highway.js via window.feedBack.emit(), so
// subscribe through the same EventTarget. window.feedBack is created in
// this same file before _populateVizPicker is reachable, so the global
// is guaranteed to exist by the time this listener registers — but guard
// anyway in case this module is ever loaded standalone for tests.
let _pendingPromotionNag = false;
if (window.feedBack && typeof window.feedBack.on === 'function') {
    window.feedBack.on('song:ready', () => {
        if (!_pendingPromotionNag) return;
        _pendingPromotionNag = false;
        _showPromotionNag();
    });
}

function _showPromotionNag() {
    // Lightweight toast — no dependency on a generic toast helper, since
    // app.js doesn't currently have one. Fixed bottom-center, dismissed
    // by clicking either action button or the × close.
    const existing = document.getElementById('feedBack-3d-nag');
    if (existing) existing.remove();
    const wrap = document.createElement('div');
    wrap.id = 'feedBack-3d-nag';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'false');
    wrap.setAttribute('aria-label', '3D Highway upgrade notification');
    wrap.style.cssText = `
        position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
        background: linear-gradient(145deg, #1a1a30 0%, #0d0d18 100%);
        border: 1px solid rgba(64,128,224,0.4);
        border-radius: 12px; padding: 12px 16px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(64,128,224,0.15);
        font-size: 13px; color: #e2e8f0; z-index: 10000;
        max-width: 480px; display: flex; align-items: center; gap: 12px;
    `;
    wrap.innerHTML = `
        <span aria-live="polite" style="flex:1;">Your highway was upgraded to <strong>3D</strong>.</span>
        <button type="button" data-act="tour" style="background:rgba(64,128,224,0.25);color:#e2e8f0;border:1px solid rgba(64,128,224,0.5);padding:6px 12px;border-radius:8px;font-size:12px;cursor:pointer;">Try the tour</button>
        <button type="button" data-act="back" style="background:transparent;color:#cbd5e1;border:1px solid rgba(255,255,255,0.1);padding:6px 12px;border-radius:8px;font-size:12px;cursor:pointer;">Switch back to 2D</button>
        <button type="button" data-act="dismiss" aria-label="Dismiss" style="background:transparent;color:#6b7280;border:none;font-size:18px;cursor:pointer;padding:0 4px;line-height:1;">×</button>
    `;
    wrap.addEventListener('click', (ev) => {
        const btn = ev.target.closest('button[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'tour') {
            try {
                if (window.feedBackTour && typeof window.feedBackTour.start === 'function') {
                    window.feedBackTour.start('highway_3d');
                }
            } catch (_) {}
        } else if (act === 'back') {
            setViz('default');
        }
        wrap.remove();
    });
    document.body.appendChild(wrap);
}

function _showWebGL2FallbackToast() {
    // One-time fallback notice. Same lightweight DOM as the nag, simpler
    // copy and only a dismiss button.
    if (document.getElementById('feedBack-3d-fallback')) return;
    const wrap = document.createElement('div');
    wrap.id = 'feedBack-3d-fallback';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'false');
    wrap.setAttribute('aria-label', 'WebGL2 not available');
    wrap.style.cssText = `
        position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
        background: #181830; border: 1px solid rgba(255,180,80,0.4);
        border-radius: 12px; padding: 10px 14px;
        font-size: 12px; color: #e2e8f0; z-index: 10000;
        display: flex; align-items: center; gap: 10px;
    `;
    wrap.innerHTML = `
        <span aria-live="polite">3D Highway needs WebGL2 — falling back to Classic 2D.</span>
        <button type="button" data-act="dismiss" aria-label="Dismiss" style="background:transparent;color:#6b7280;border:none;font-size:16px;cursor:pointer;padding:0 4px;line-height:1;">×</button>
    `;
    wrap.addEventListener('click', (ev) => {
        if (ev.target.closest('button[data-act]')) wrap.remove();
    });
    document.body.appendChild(wrap);
    setTimeout(() => { try { wrap.remove(); } catch (_) {} }, 8000);
}

// The "default" option in the dropdown is the built-in 2D highway that
// lives inside createHighway(); selecting it calls setRenderer(null) which
// restores the default renderer.
function _ensureVenueVizOption(sel) {
    if (!sel) return;
    if (Array.from(sel.options).some(opt => opt.value === 'venue')) return;
    if (!Array.from(sel.options).some(opt => opt.value === 'highway_3d')) return;
    const h3dOpt = Array.from(sel.options).find(opt => opt.value === 'highway_3d');
    const opt = document.createElement('option');
    opt.value = 'venue';
    opt.textContent = 'Venue';
    if (h3dOpt && h3dOpt.nextSibling) sel.insertBefore(opt, h3dOpt.nextSibling);
    else sel.appendChild(opt);
}

function _syncVenueVizPlayerClass(vizId) {
    if (window.v3VenueViz && typeof window.v3VenueViz.setSelectedVizId === 'function') {
        window.v3VenueViz.setSelectedVizId(vizId);
        return;
    }
    if (window.v3VenueViz && typeof window.v3VenueViz.syncPlayerVizClass === 'function') {
        window.v3VenueViz.syncPlayerVizClass(vizId);
        return;
    }
    const player = document.getElementById('player');
    if (player) player.classList.toggle('is-venue-visualization', vizId === 'venue');
}

export async function _populateVizPicker(plugins) {
    const sel = document.getElementById('viz-picker');
    if (!sel) return;
    // Clear any previously-appended plugin options so calling this
    // function more than once (e.g. from DevTools, or a hot-reloaded
    // plugin) doesn't produce duplicates. The built-in "auto" and
    // "default" options are static markup — preserve them.
    const BUILTIN_OPT_VALUES = new Set(['auto', 'default', 'venue']);
    Array.from(sel.options).forEach(opt => {
        if (!BUILTIN_OPT_VALUES.has(opt.value)) sel.removeChild(opt);
    });
    // Accept a pre-fetched plugins array (normal startup path reuses
    // loadPlugins' fetch). Fall back to our own fetch if called
    // standalone — e.g. from the DevTools console for debugging.
    if (!Array.isArray(plugins)) {
        plugins = [];
        try {
            const resp = await fetch('/api/plugins');
            if (resp.ok) plugins = await resp.json();
        } catch (e) {
            console.warn('viz picker: /api/plugins fetch failed', e);
        }
    }
    const vizPlugins = plugins.filter(p => p && p.type === 'visualization');
    // "default" is reserved for the built-in 2D renderer option and
    // "auto" is reserved for the Auto-mode entry — both already in the
    // <select>. A plugin with either id would collide: the
    // restore-from-localStorage lookup would find the built-in entry,
    // dragging the plugin into never-selected land silently. Fail
    // loudly instead.
    const RESERVED_IDS = new Set(['default', 'auto']);
    for (const p of vizPlugins) {
        if (RESERVED_IDS.has(p.id)) {
            console.error(`viz picker: plugin id '${p.id}' collides with a reserved built-in picker entry ('auto' = Auto mode, 'default' = built-in 2D highway); rename the plugin's id in plugin.json to include it in the picker.`);
            continue;
        }
        // Skip entries where the plugin script hasn't exposed a factory —
        // likely means the script failed to load, or the plugin declared
        // itself as a viz without shipping the factory yet.
        const factoryName = 'feedBackViz_' + p.id;
        if (typeof window[factoryName] !== 'function') {
            console.warn(`viz picker: plugin '${p.id}' has type=visualization but ${factoryName} is not a function; skipping`);
            continue;
        }
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name || p.id;
        sel.appendChild(opt);
    }
    _ensureVenueVizOption(sel);
    // Refresh the visualization capability domain's provider registry from
    // the picker entries just built (the domain host introspects each
    // factory global for contextType / predicate metadata).
    if (window.feedBack.vizDomain && typeof window.feedBack.vizDomain.refreshProviders === 'function') {
        try {
            // The host reads manifest-declared per-instance settings
            // (capabilities.visualization.settings, feedBack#849) from the
            // registered capability participant by id — no need to pass them
            // through the picker here.
            window.feedBack.vizDomain.refreshProviders(
                Array.from(sel.options)
                    .filter(opt => !BUILTIN_OPT_VALUES.has(opt.value))
                    .map(opt => ({ id: opt.value, label: opt.text }))
            );
        } catch (e) { console.warn('viz picker: capability provider refresh failed', e); }
    }
    // Restore previous selection if still available. Direct option
    // scan instead of a CSS-selector lookup so we don't depend on
    // CSS.escape (missing in some test environments / older runtimes)
    // and so a weird saved string (e.g. with a quote) can't throw.
    // localStorage.getItem can itself throw when storage is blocked
    // (private mode, sandboxed iframes, some strict test runners);
    // fall back to null so the startup chain doesn't abort.
    let saved = null;
    try { saved = localStorage.getItem('vizSelection'); }
    catch (e) { console.warn('viz picker: unable to read vizSelection', e); }

    // ── 3D promotion migration (feedBack#160 PR 3) ──────────────────────
    // Existing users with `vizSelection='default'` (the old built-in 2D
    // highway) are auto-flipped to the bundled 3D Highway exactly once,
    // and a non-modal nag toast offers them "Try the tour" / "Switch
    // back to 2D" the first time they open the player. Users on `auto`
    // are left alone (auto-pick semantics unchanged). Users on a custom
    // viz plugin are left alone. WebGL2 absence falls back via setViz.
    if (saved === 'default' && !_hasPromotedFlag()) {
        const has3D = Array.from(sel.options).some(o => o.value === 'highway_3d');
        if (has3D && _canRun3D()) {
            saved = 'highway_3d';
            try { localStorage.setItem('vizSelection', 'highway_3d'); } catch (_) {}
            _markPromoted();
            _pendingPromotionNag = true;
            // Race guard: if song:ready already fired before _populateVizPicker
            // ran (e.g. a deeplink or a fast-loading song), getSongInfo() will
            // already be non-empty and we'll never receive another song:ready
            // in this session. Show the nag immediately in that case.
            const _si = window.highway && window.highway.getSongInfo();
            if (_si && _si.title) {
                _pendingPromotionNag = false;
                _showPromotionNag();
            }
        } else if (has3D && !_canRun3D()) {
            // 3D registered but WebGL2 absent — promote in name but
            // immediately fall back so we don't ping-pong on every load.
            // Set the flag so we don't try again next reload.
            _markPromoted();
            _showWebGL2FallbackToast();
        }
        // No `highway_3d` option (plugin unloaded?) → leave saved as
        // 'default'. We'll retry the migration once the plugin is back.
    }

    const savedMatches = saved && Array.from(sel.options).some(opt => opt.value === saved);
    if (savedMatches) {
        sel.value = saved;
        // 'default' needs no setViz — the highway already starts with
        // the built-in renderer. 'auto' runs setViz so _autoMatchViz
        // fires, though it's a no-op before the first song_info frame.
        if (saved !== 'default') setViz(saved);
    } else if (saved) {
        // Saved selection references an option that no longer exists —
        // plugin uninstalled since last session, renamed, or the plugin
        // script failed to register its factory this time. Clear the
        // stale value so we don't keep trying the same missing viz on
        // every reload, and fall through to the fresh-install default
        // below.
        try { localStorage.removeItem('vizSelection'); }
        catch (_) { /* storage blocked; ignore */ }
        saved = null;
    }
    if (!saved) {
        // Fresh install (or post-cleanup fallthrough): default to the
        // bundled 3D Highway when available + WebGL2-capable, falling
        // back to Auto otherwise so the arrangement-matching plugins
        // (piano on Keys songs, drums on Drums songs, ...) still take
        // over for non-3D arrangements.
        const has3D = Array.from(sel.options).some(o => o.value === 'highway_3d');
        if (has3D && _canRun3D()) {
            sel.value = 'highway_3d';
            try { localStorage.setItem('vizSelection', 'highway_3d'); } catch (_) {}
            setViz('highway_3d');
        } else {
            sel.value = 'auto';
            try { localStorage.setItem('vizSelection', 'auto'); } catch (_) {}
            if (has3D && !_canRun3D()) { _markPromoted(); _showWebGL2FallbackToast(); }
        }
    }
    // Close a startup race: if playback began before loadPlugins
    // finished, song:ready already fired while the picker had no
    // plugin options — _autoMatchViz saw no candidates and left the
    // default active. Now that plugins are registered, re-evaluate
    // against whatever song is currently loaded (a no-op when no song
    // has been loaded yet, since window.highway.getSongInfo() returns {}).
    if (sel.value === 'auto') _autoMatchViz();
}

function _tagVizRenderer(renderer, id) {
    if (!renderer || !id) return renderer;
    try {
        if (!renderer.pluginId) renderer.pluginId = id;
        if (!renderer.source) renderer.source = id;
    } catch (_) {}
    return renderer;
}

// Attribution hooks into the visualization capability domain (cap:6).
// Guarded no-ops when the domain host isn't loaded (minimal/test pages).
function _notifyVizDomain(id, source) {
    const domain = window.feedBack && window.feedBack.vizDomain;
    if (domain && typeof domain.notifyRendererChanged === 'function') {
        try { domain.notifyRendererChanged(id, source); } catch (_) {}
    }
}

function _noteVizAutoMatch(id, matched) {
    const domain = window.feedBack && window.feedBack.vizDomain;
    if (domain && typeof domain.noteAutoMatch === 'function') {
        try { domain.noteAutoMatch(id, matched); } catch (_) {}
    }
}

function _installVizRenderer(renderer, id, source = 'user-select') {
    window.highway.setRenderer(_tagVizRenderer(renderer, id));
    // Drop any stale notation-view hint now that we have a resolved renderer id.
    // This is also the path used by _autoMatchViz() after it resolves 'auto' to
    // a real plugin id, so the null passed at evaluation start is corrected here.
    _dropStaleNotationHint(id);
    _notifyVizDomain(id, source);
    if (window.v3VenueViz && typeof window.v3VenueViz.notifyRendererInstalled === 'function') {
        window.v3VenueViz.notifyRendererInstalled(id);
    }
}

export function setViz(id) {
    // Helper: reset the UI and persisted selection to the built-in
    // "default" entry. Called whenever the requested viz can't be
    // applied (missing factory, factory threw, factory returned a
    // non-conforming renderer) so the picker, localStorage, and the
    // highway's active renderer stay in sync.
    const fallbackToDefault = () => {
        try { localStorage.setItem('vizSelection', 'default'); } catch (_) {}
        const sel = document.getElementById('viz-picker');
        if (sel) sel.value = 'default';
        window.highway.setRenderer(null);
        _syncVenueVizPlayerClass('default');
        if (window.v3VenueScene3d && typeof window.v3VenueScene3d.syncViz === 'function') {
            window.v3VenueScene3d.syncViz('default');
        }
        _notifyVizDomain('default', 'fallback');
        _maybeShowNotationViewHint('default');
    };

    // When switching away from Auto, reset the closed-state label so the
    // Auto option shows base text the next time the user opens the dropdown.
    // Also cancel any pending viz:renderer:ready listener from the previous
    // Auto match cycle so it can't set a stale label after we've moved on.
    if (id !== 'auto') {
        if (_cancelPendingAutoLabel) { _cancelPendingAutoLabel(); _cancelPendingAutoLabel = null; }
        _setAutoVizLabel(null);
    }

    if (id === 'default' || !id) {
        try { localStorage.setItem('vizSelection', id || 'default'); } catch (_) {}
        const _sel = document.getElementById('viz-picker');
        if (_sel) _sel.value = 'default';
        window.highway.setRenderer(null);
        _syncVenueVizPlayerClass('default');
        if (window.v3VenueScene3d && typeof window.v3VenueScene3d.syncViz === 'function') {
            window.v3VenueScene3d.syncViz('default');
        }
        _notifyVizDomain('default', 'user-select');
        _maybeShowNotationViewHint('default');
        return;
    }
    if (id === 'auto') {
        try { localStorage.setItem('vizSelection', 'auto'); } catch (_) {}
        _syncVenueVizPlayerClass('auto');
        if (window.v3VenueScene3d && typeof window.v3VenueScene3d.syncViz === 'function') {
            window.v3VenueScene3d.syncViz('auto');
        }
        _autoMatchViz();
        return;
    }
    if (id === 'venue') {
        if (!_canRun3D()) {
            console.warn('viz picker: WebGL2 unavailable, falling back to Classic 2D Highway');
            _markPromoted();
            _showWebGL2FallbackToast();
            fallbackToDefault();
            return;
        }
        const venueFactory = window['feedBackViz_highway_3d'];
        if (typeof venueFactory !== 'function') {
            console.error('viz picker: venue requires feedBackViz_highway_3d');
            fallbackToDefault();
            return;
        }
        let venueRenderer;
        try { venueRenderer = venueFactory(); }
        catch (e) {
            console.error('viz picker: feedBackViz_highway_3d threw for venue mode', e);
            fallbackToDefault();
            return;
        }
        if (!venueRenderer || typeof venueRenderer.draw !== 'function') {
            console.error('viz picker: feedBackViz_highway_3d returned an invalid renderer for venue mode');
            fallbackToDefault();
            return;
        }
        try { localStorage.setItem('vizSelection', 'venue'); } catch (_) {}
        const _venueSel = document.getElementById('viz-picker');
        if (_venueSel) _venueSel.value = 'venue';
        _installVizRenderer(venueRenderer, 'highway_3d');
        _syncVenueVizPlayerClass('venue');
        console.info('[venue-viz] selected venue -> renderer highway_3d, venueClass=true');
        if (window.v3VenueMoodFx && typeof window.v3VenueMoodFx.onVenueVisualizationSelected === 'function') {
            window.v3VenueMoodFx.onVenueVisualizationSelected();
        }
        if (window.v3VenueScene3d && typeof window.v3VenueScene3d.syncViz === 'function') {
            window.v3VenueScene3d.syncViz('venue');
        }
        _maybeShowNotationViewHint('highway_3d');
        return;
    }
    // 3D Highway specifically gates on WebGL2. Any future WebGL viz
    // plugin should declare its own probe — for now the bundled 3D
    // Highway is the only viz with this requirement, so the gate is
    // hardcoded. Falling back to 'default' (Classic 2D) keeps the
    // picker in sync; toast informs the user.
    if (id === 'highway_3d' && !_canRun3D()) {
        console.warn('viz picker: WebGL2 unavailable, falling back to Classic 2D Highway');
        _markPromoted();
        _showWebGL2FallbackToast();
        fallbackToDefault();
        return;
    }
    const factory = window['feedBackViz_' + id];
    if (typeof factory !== 'function') {
        console.error(`viz picker: factory feedBackViz_${id} not available`);
        fallbackToDefault();
        return;
    }
    let renderer;
    try { renderer = factory(); }
    catch (e) {
        console.error(`viz picker: factory feedBackViz_${id} threw`, e);
        fallbackToDefault();
        return;
    }
    // Validate shape — window.highway.setRenderer will itself fall back to
    // default on a bad renderer, but without this check the UI and
    // localStorage would still advertise the broken selection.
    if (!renderer || typeof renderer.draw !== 'function') {
        console.error(`viz picker: factory feedBackViz_${id} returned an invalid renderer (missing draw)`);
        fallbackToDefault();
        return;
    }
    // Persist only once we know the renderer is valid.
    try { localStorage.setItem('vizSelection', id); } catch (_) {}
    _installVizRenderer(renderer, id);
    _syncVenueVizPlayerClass(id);
    if (window.v3VenueScene3d && typeof window.v3VenueScene3d.syncViz === 'function') {
        window.v3VenueScene3d.syncViz(id);
    }
    _maybeShowNotationViewHint(id);
}

// Auto mode: evaluate each registered viz factory's static
// `matchesArrangement(songInfo)` predicate and install the first
// matching renderer. No match → fall back to the built-in 2D window.highway.
//
// vizSelection stays 'auto' across invocations so the next song:ready
// re-evaluates. An explicit picker choice overrides Auto by persisting
// a different vizSelection.
//
// Enumerates viz plugins by walking the picker's own <option> list —
// that's the canonical set built by _populateVizPicker above and keeps
// us from needing a second module-level registry.
// Helper: update the closed-state label of the Auto option to show what was resolved.
// Resets to the base label when called with no argument (at evaluation start).
// _autoVizBaseLabel is captured from the DOM on first call so the reset text
// always matches the initial markup rather than a hardcoded duplicate.
let _autoVizBaseLabel = null;
function _setAutoVizLabel(resolvedText) {
    const opt = document.querySelector('#viz-picker option[value="auto"]');
    if (!opt) return;
    if (_autoVizBaseLabel === null) _autoVizBaseLabel = opt.text;
    opt.text = resolvedText != null ? `Auto \u2192 ${resolvedText}` : _autoVizBaseLabel;
}

// Holds a cleanup function for the pending viz:renderer:ready listener
// registered by _autoMatchViz(). Called at the start of each new evaluation
// to remove any listener left over from the previous match cycle.
let _cancelPendingAutoLabel = null;

// One-shot (per song) hint shown when a notation-only arrangement falls back
// to the built-in 2D window.highway. Such arrangements carry no wire notes
// (sloppak-spec §5.3: `file:` may be omitted when `notation:` is present), so
// the default renderer draws an empty board — without this the user is left
// staring at a silently blank window.highway. Core ships no notation view; point at
// the viz picker instead.
let _notationHintShownFor = null;
function _showNotationViewHint(arrangementIndex, activeVizId) {
    const filename = (window.feedBack && window.feedBack.currentSong
        && window.feedBack.currentSong.filename) || '';
    if (_notationHintShownFor === filename) return;
    _notationHintShownFor = filename;
    const player = document.getElementById('player');
    if (!player) return;
    const prev = document.getElementById('notation-view-hint');
    if (prev) prev.remove();
    const el = document.createElement('div');
    el.id = 'notation-view-hint';
    el.className = 'notation-view-hint';
    el.dataset.filename = filename;
    if (arrangementIndex != null) el.dataset.arrangementIndex = String(arrangementIndex);
    if (activeVizId) el.dataset.vizId = String(activeVizId);
    el.textContent = 'This arrangement is notation-only — the built-in highway has nothing to draw. '
        + 'Install a notation view plugin (e.g. Staff View or Keys Highway 3D) and select it in the visualization picker.';
    const close = document.createElement('button');
    close.className = 'notation-view-hint-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', () => el.remove());
    el.appendChild(close);
    player.appendChild(el);
    setTimeout(() => { el.remove(); }, 15000);
}

// Decide whether the active song needs the notation-view hint: the song is
// notation-only (has_notation + zero wire notes on the active arrangement)
// AND the given viz doesn't claim it via matchesArrangement. Covers both the
// Auto fallthrough (activeVizId='default') and explicit selections, where the
// renderer persists across songs — e.g. the fresh-install default highway_3d
// would otherwise show a silently empty 3D board on a notation-only song.
// Returns true when the hint was shown.
// A hint left over from a previous song refers to the wrong arrangement —
// drop it whenever the viz evaluation runs for a different filename, a
// different arrangement index, or a different active viz.
function _dropStaleNotationHint(activeVizId) {
    const stale = document.getElementById('notation-view-hint');
    if (!stale) return;
    const curFilename = (window.feedBack && window.feedBack.currentSong
        && window.feedBack.currentSong.filename) || '';
    if (stale.dataset.filename !== curFilename) { stale.remove(); return; }
    const songInfo = (typeof window.highway?.getSongInfo === 'function')
        ? (window.highway.getSongInfo() || {}) : {};
    const curArrIdx = songInfo.arrangement_index != null ? String(songInfo.arrangement_index) : null;
    if (curArrIdx !== null && stale.dataset.arrangementIndex !== undefined
            && stale.dataset.arrangementIndex !== curArrIdx) {
        stale.remove(); return;
    }
    if (activeVizId && stale.dataset.vizId !== undefined && stale.dataset.vizId !== String(activeVizId)) {
        stale.remove();
    }
}

export function _maybeShowNotationViewHint(activeVizId) {
    _dropStaleNotationHint(activeVizId);
    const songInfo = (typeof window.highway?.getSongInfo === 'function')
        ? (window.highway.getSongInfo() || {}) : {};
    const activeArr = Array.isArray(songInfo.arrangements)
        ? songInfo.arrangements.find(a => a.index === songInfo.arrangement_index)
        : null;
    if (!(songInfo.has_notation && activeArr && activeArr.notes === 0)) {
        // Condition no longer holds (arrangement switched to one with notes, or
        // notation flag cleared) — remove any residual hint so it doesn't
        // linger and contradict current state.
        const existing = document.getElementById('notation-view-hint');
        if (existing) existing.remove();
        return false;
    }
    if (activeVizId && activeVizId !== 'default' && activeVizId !== 'auto') {
        const factory = window['feedBackViz_' + activeVizId];
        let claimed = false;
        try {
            claimed = typeof factory === 'function'
                && typeof factory.matchesArrangement === 'function'
                && !!factory.matchesArrangement(songInfo);
        } catch (_) { /* predicate threw — treat as unclaimed */ }
        if (claimed) {
            // Renderer now claims notation — drop any existing hint.
            const existing = document.getElementById('notation-view-hint');
            if (existing) existing.remove();
            return false;
        }
    }
    _showNotationViewHint(songInfo.arrangement_index, activeVizId);
    return true;
}

export function _autoMatchViz() {
    const sel = document.getElementById('viz-picker');
    if (!sel) return;
    // Pass null here: sel.value is 'auto', which is never a valid viz-id hint
    // key. Passing 'auto' would incorrectly drop hints whose data-viz-id is
    // 'default' (the resolved renderer after a no-match pass), making the
    // hint unshowable for the rest of the song. Drop using the resolved id
    // happens later inside _installVizRenderer once the id is known.
    _dropStaleNotationHint(null);
    // Cancel any pending viz:renderer:ready listener from a previous match
    // cycle. The song may change before the previous renderer's async init
    // settles; we don't want that stale listener to clobber the new label.
    if (_cancelPendingAutoLabel) { _cancelPendingAutoLabel(); _cancelPendingAutoLabel = null; }
    // Reset label at evaluation start so a stale resolved label never persists
    // if the song changes or the picker re-evaluates with a different outcome.
    _setAutoVizLabel(null);
    const songInfo = (typeof window.highway?.getSongInfo === 'function')
        ? (window.highway.getSongInfo() || {}) : {};
    // Only update the label when a real song is loaded. Before the first
    // song_info frame, getSongInfo() returns {} — leaving the reset state
    // ("Auto (match arrangement)") is correct; we haven't evaluated yet.
    const hasSong = Object.keys(songInfo).length > 0;
    // Options are stable in DOM order, which matches what users see in
    // the picker. The underlying order comes from /api/plugins →
    // _populateVizPicker, and /api/plugins reflects the order the
    // plugin loader discovered plugins in — plugins/__init__.py walks
    // `sorted(plugins_base_dir.iterdir())`, i.e. sorted by the on-disk
    // PLUGIN DIRECTORY name (e.g. "feedBack-plugin-drums" sorts
    // before "feedBack-plugin-piano"), not by the plugin id declared
    // in plugin.json. Two consequences worth noting:
    //   1. First match wins among registered viz plugins — keep each
    //      plugin's matchesArrangement predicate narrow to avoid
    //      stealing songs from more specialized viz.
    //   2. If you need a strict priority when multiple plugins match
    //      the same song, name the higher-priority plugin's directory
    //      earlier alphabetically. The picker dropdown reveals the
    //      actual tiebreaker at a glance.
    const candidateIds = Array.from(sel.options)
        .map(o => o.value)
        .filter(v => v !== 'auto' && v !== 'default');
    for (const id of candidateIds) {
        const factory = window['feedBackViz_' + id];
        if (typeof factory !== 'function') continue;
        // If the factory statically declares contextType='webgl2', gate on
        // WebGL2 availability so a match never installs a renderer that'll
        // fail at init. This is the generic version of the old hard-coded
        // highway_3d check — any future WebGL2 viz gets the same protection
        // for free without needing a special-case here.
        const factoryCtxType = typeof factory.contextType === 'string' ? factory.contextType : '2d';
        if (factoryCtxType === 'webgl2' && !_canRun3D()) continue;
        const predicate = factory.matchesArrangement;
        if (typeof predicate !== 'function') continue;
        let matched = false;
        try { matched = !!predicate(songInfo); }
        catch (err) {
            console.error(`viz auto: matchesArrangement for ${id} threw`, err);
            continue;
        }
        if (!matched) continue;
        let renderer;
        try { renderer = factory(); }
        catch (err) {
            console.error(`viz auto: factory feedBackViz_${id} threw`, err);
            continue;
        }
        if (!renderer || typeof renderer.draw !== 'function') {
            console.error(`viz auto: factory feedBackViz_${id} returned an invalid renderer (missing draw)`);
            continue;
        }
        // Deliberately NOT persisting id — vizSelection stays 'auto' so
        // the next song:ready re-evaluates against the new arrangement.
        //
        // Register the viz:renderer:ready listener BEFORE setRenderer() so we
        // don't miss the event for sync renderers (no readyPromise), which emit
        // it immediately inside setRenderer(). The _onReady guard still checks
        // sel.value so a sync init failure (viz:reverted → sel.value='default')
        // that fires during setRenderer() is handled correctly — the listener
        // fires but finds sel.value !== 'auto' and skips the label update.
        if (hasSong) {
            const matchedOpt = Array.from(sel.options).find(o => o.value === id);
            const labelText = matchedOpt ? matchedOpt.text : id;
            function _onReady() { if (sel.value === 'auto') _setAutoVizLabel(labelText); }
            window.feedBack.on('viz:renderer:ready', _onReady, { once: true });
            _cancelPendingAutoLabel = () => window.feedBack.off('viz:renderer:ready', _onReady);
        }
        _installVizRenderer(renderer, id, 'auto-match');
        _noteVizAutoMatch(id, true);
        return;
    }
    // No match — restore the built-in 2D window.highway. setRenderer(null) is
    // a no-op when the default is already active. If the previous Auto
    // pick was a WebGL renderer, window.highway.setRenderer() handles the
    // context-type change by replacing the canvas element (cloneNode +
    // replaceWith) so the default 2D renderer's getContext('2d') always
    // succeeds — no canvas-lock limitation here.
    window.highway.setRenderer(null);
    _notifyVizDomain('default', 'auto-match');
    _noteVizAutoMatch('default', false);
    // Update the label so the user can see Auto resolved to the built-in
    // window.highway. Read from the DOM rather than hard-coding the name so a
    // future rename of the default entry is automatically reflected.
    if (hasSong) {
        const defaultOpt = Array.from(sel.options).find(o => o.value === 'default');
        // Notation-only arrangement falling through to the default renderer:
        // there are no wire notes, so the board would be silently empty.
        // Flag it in the Auto label and show the one-shot install hint.
        if (_maybeShowNotationViewHint('default')) {
            _setAutoVizLabel('no notation view installed');
        } else {
            _setAutoVizLabel(defaultOpt ? defaultOpt.text : null);
        }
    }
}

// ── viz:reverted ────────────────────────────────────────────────────────
// Lifted out of a top-level listener block in app.js that it shared with the
// non-viz song:loaded / arrangement:changed / song:ready handlers (those stay).
//
// It has to move WITH the state: it REASSIGNS `_cancelPendingAutoLabel`, and an
// imported binding is read-only — `_cancelPendingAutoLabel = null` would throw if
// this listener stayed behind in app.js. Same guard as the block it came from.
if (window.feedBack && typeof window.feedBack.on === 'function') {
    // Highway signals when it's auto-reverted to the default renderer
    // after a broken plugin (init failure or repeated draw failures).
    // Sync the picker + persisted selection so the UI stops advertising
    // the broken choice and the user doesn't hit the same failure on
    // next reload.
    window.feedBack.on('viz:reverted', (e) => {
        const sel = document.getElementById('viz-picker');
        if (sel) sel.value = 'default';
        // Cancel any pending viz:renderer:ready label listener — the renderer
        // that was queued never became (or stayed) active.
        if (_cancelPendingAutoLabel) { _cancelPendingAutoLabel(); _cancelPendingAutoLabel = null; }
        // Clear any Auto-resolved label — the renderer that was advertised
        // never became (or stayed) active.
        _setAutoVizLabel(null);
        try { localStorage.setItem('vizSelection', 'default'); } catch (_) {}
        console.warn(
            `viz picker: reverted to default renderer (${e.detail?.reason || 'unknown'}).`
        );
    });
}

