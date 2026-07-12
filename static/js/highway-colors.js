// Highway string colours — user theming for the 2D + bundled 3D highways.
//
// Carved verbatim out of static/app.js (R3a). A LEAF module: imports nothing.
//
// Slot→hex colours (per named string slot, so a 6-string map survives a 4-string
// bass and a 7-string's Low B), named themes in localStorage, a copy/paste share
// code, and the Settings-screen picker UI. The highways colour by raw string
// INDEX, so a translation table maps named slots → per-index colours for the
// current arrangement, recomputed whenever a song loads.
//
// Exports exactly two entry points; the other 43 symbols (the HWC_* tables, the
// theme store, the picker handlers, the window.feedBack facade) are used nowhere
// else in core and stay private. The Settings buttons are wired by
// addEventListener inside hwcInitSettingsUI — there are no inline on*= handlers
// here, so nothing needs re-exposing on window.
//
// It does import uiPrompt from ./dom.js (the "name this theme" prompt) — which is
// precisely why dom.js was carved out first: without it this module would have
// needed a host seam back into app.js.
import { uiPrompt } from './dom.js';

// Colors are assigned per NAMED string (Low E, A, D, G, B, High E, plus the
// extended low strings of 7/8-string guitars), so a string keeps its color
// when the string count changes (e.g. Low E stays the same from a 6-string
// guitar to a 4-string bass, and on a 7-string the extra Low B takes the
// 7-string slot rather than bumping every color over). The highways color by
// raw string INDEX, so a small translation table maps named slots → per-index
// colors for the current arrangement; this is recomputed whenever a song loads
// (its string count / bass-vs-guitar may differ). Applies to BOTH the 2D and
// bundled 3D highway; stored client-side; shared via a copy/paste code.
const HWC_KEY_ACTIVE = 'highwayStringColors';    // JSON slot→hex map (active)
const HWC_KEY_THEMES = 'highwayColorThemes';     // { "<name>": {slot:hex} }
const HWC_KEY_NAME = 'highwayColorActiveName';   // selected saved theme name, or ''
const HWC_HEX_RE = /^#[0-9a-fA-F]{6}$/;

// Named color slots, in display order (high → low, then extended low strings).
const HWC_SLOTS = [
    { key: 'highE', label: 'High E', sub: '1st' },
    { key: 'B', label: 'B', sub: '2nd' },
    { key: 'G', label: 'G', sub: '3rd' },
    { key: 'D', label: 'D', sub: '4th' },
    { key: 'A', label: 'A', sub: '5th' },
    { key: 'lowE', label: 'Low E', sub: '6th / lowest' },
    { key: 'low7', label: 'Low B', sub: '7-string' },
    { key: 'low8', label: 'Low F#', sub: '8-string' },
];
const HWC_SLOT_KEYS = HWC_SLOTS.map((s) => s.key);
// Hardcoded fallback (matches the highway defaults) for before the 2D highway
// is queryable.
const HWC_DEFAULT_FALLBACK = { lowE: '#cc0000', A: '#cca800', D: '#0066cc', G: '#cc6600', B: '#00cc66', highE: '#9900cc', low7: '#cc00aa', low8: '#00cccc' };

// One-click string-color presets. Each is a full named-slot → hex map (every
// slot, so 7/8-string charts get a sensible color too) keyed by the same slot
// names as HWC_SLOTS, so "Low E" always lands on the lowE slot regardless of
// string count. Hues are chosen for the dark scene (~#080810): each color is
// bright enough to read on black and distinct from its neighbours.
//   - warmcool: an ordered low→high spectrum (warm reds at the bass end →
//     cool blues/violet at the treble end) so pitch reads as color temperature.
//   - vivid: punchier, higher-saturation take on the classic mapping for a
//     stage-bright look.
//   - colorblind: the Okabe–Ito accessible qualitative palette (vermillion,
//     orange, yellow, bluish-green, sky-blue, blue, reddish-purple), the most
//     distinguishable option for deuteranopia/protanopia.
//   - colorblind_deuteranope: a deuteranope-tuned variant of the Okabe–Ito set
//     above, contributed by a deuteranopic player who still found that set hard
//     to separate. Retunes the six main strings (red / yellow-green / blue /
//     orange / teal / deep-purple) and keeps its 7/8-string colors unchanged.
//   - neon: electric, max-saturation hues whose LIGHTNESS deliberately zig-zags
//     between neighbours (bright→bright→brightest→dark blue→bright green→dark
//     violet) so adjacent strings separate harder than vivid — a stage/stream
//     "pop" set, not a vivid duplicate.
//   - accessible: a CVD-safe set ORDERED by ascending lightness low→high (deep
//     blue → vermilion → azure → orange → yellow → cream). Unlike the unordered
//     Okabe–Ito 'colorblind' set, the value ramp teaches pitch low→high AND
//     survives grayscale/colorblindness; no red/green pair carries meaning.
//   - ember: a warm, lower-intensity family for long sessions, luminance-stepped
//     from rust/ember at the bass through warm gold to cream at the treble. The
//     bass embers stay light enough to clear the near-black scene.
//   - tapedeck: a vintage-print, slightly desaturated ochre-tinted family
//     (rust-red → mustard → avocado → teal → faded denim → dusty plum). Muted
//     hues collapse, so neighbour LIGHTNESS deliberately zig-zags to keep the
//     dusty mid-strings (avocado/teal/denim) distinct on the dark board.
//   - crtgreen / crtamber: monochrome CRT-phosphor families (green / amber)
//     stepped by STRICT ASCENDING LIGHTNESS low→high. Mono sets collapse on hue,
//     so lightness alone carries the ordering. Verified to stay legible even on
//     the matching phosphor scene board (green-on-green / amber-on-amber).
//   - pitchramp: a smooth low→high hue sweep (violet → blue → teal → green →
//     yellow → warm-white) with rising lightness — memorable + teaches order.
//   - sunrise: a soft dawn gradient (plum → rose → coral → amber → gold → cream),
//     warm and lower-intensity, lightness-stepped low→high.
const HWC_PRESETS = [
    {
        id: 'warmcool', label: 'Warm → Cool',
        colors: { lowE: '#ff3b30', A: '#ff7a18', D: '#ffc400', G: '#36c46a', B: '#2196f3', highE: '#9b5cff', low7: '#ff2d78', low8: '#00c2c7' },
    },
    {
        id: 'vivid', label: 'Vivid',
        colors: { lowE: '#ff2222', A: '#ffd000', D: '#1e8bff', G: '#ff7a00', B: '#16d65a', highE: '#b24bff', low7: '#ff3cc0', low8: '#15d8d8' },
    },
    {
        id: 'colorblind', label: 'Colorblind-friendly',
        colors: { lowE: '#d55e00', A: '#e69f00', D: '#f0e442', G: '#009e73', B: '#56b4e9', highE: '#cc79a7', low7: '#0072b2', low8: '#999999' },
    },
    {
        id: 'colorblind_deuteranope', label: 'Colorblind (deuteranope)',
        colors: { lowE: '#aa1414', A: '#88de00', D: '#1889e3', G: '#c6601c', B: '#00f5b2', highE: '#4d2173', low7: '#0072b2', low8: '#999999' },
    },
    {
        id: 'neon', label: 'Neon',
        colors: { lowE: '#ff1f4e', A: '#ff9d00', D: '#e9ff00', G: '#1844ff', B: '#00ff84', highE: '#d000ff', low7: '#ff00aa', low8: '#00f0ff' },
    },
    {
        id: 'accessible', label: 'Accessible (ordered)',
        colors: { lowE: '#2453c0', A: '#c44a00', D: '#3f93cf', G: '#ec9a1e', B: '#f2d43c', highE: '#f5eecb', low7: '#173f96', low8: '#0f2c6b' },
    },
    {
        id: 'ember', label: 'Warm Ember',
        colors: { lowE: '#c0392b', A: '#e0552a', D: '#ef7d2e', G: '#f6a13a', B: '#f4c95d', highE: '#f7e3a8', low7: '#9e2f23', low8: '#7d2418' },
    },
    {
        id: 'tapedeck', label: 'Tape Deck',
        colors: { lowE: '#b04632', A: '#d8ad42', D: '#5f7a34', G: '#54b3a6', B: '#5e83ad', highE: '#b98abb', low7: '#8f3526', low8: '#6f2a1e' },
    },
    {
        id: 'crtgreen', label: 'CRT Green',
        colors: { lowE: '#0a5a23', A: '#108a30', D: '#1fb53f', G: '#3ad94f', B: '#74f06a', highE: '#c7ffb0', low7: '#08491c', low8: '#063514' },
    },
    {
        id: 'crtamber', label: 'CRT Amber',
        colors: { lowE: '#7a3a02', A: '#a85f06', D: '#cf8410', G: '#e8a82a', B: '#f4cf5e', highE: '#ffeeb8', low7: '#5f2d01', low8: '#471f00' },
    },
    {
        id: 'pitchramp', label: 'Pitch Ramp',
        colors: { lowE: '#7a2390', A: '#2f5ad8', D: '#1f9bc4', G: '#2fb84a', B: '#cfd22a', highE: '#f3e0c0', low7: '#5e1a78', low8: '#440f5e' },
    },
    {
        id: 'sunrise', label: 'Sunrise',
        colors: { lowE: '#8a3a6e', A: '#bf4a5e', D: '#e0664f', G: '#f29a55', B: '#f7c873', highE: '#fce8b8', low7: '#6e2c5c', low8: '#54214a' },
    },
];

// Translation table: chart string index → named slot, for a given string count
// and bass/guitar family. Mirrors the 3D highway's _baseOpenStringMidis: bass
// shares the low strings (E A D G), 7/8-string guitars prepend lower strings,
// and sub-6 guitars truncate from the high end. Index 0 is always the lowest.
function _hwcSlotKeysForChart(sc, isBass) {
    sc = Math.max(1, Math.min(8, (sc | 0) || 6));
    if (isBass) {
        if (sc <= 4) return ['lowE', 'A', 'D', 'G'].slice(0, sc);
        if (sc === 5) return ['low7', 'lowE', 'A', 'D', 'G'];
        return ['low8', 'low7', 'lowE', 'A', 'D', 'G'].slice(0, sc);
    }
    if (sc <= 6) return ['lowE', 'A', 'D', 'G', 'B', 'highE'].slice(0, sc);
    if (sc === 7) return ['low7', 'lowE', 'A', 'D', 'G', 'B', 'highE'];
    return ['low8', 'low7', 'lowE', 'A', 'D', 'G', 'B', 'highE'];
}

// Current arrangement shape (string count + bass-vs-guitar) from the 2D window.highway.
function _hwcChartShape() {
    let sc = 6, arr = '';
    try { sc = window.highway?.getStringCount?.() || 6; } catch (_) {}
    try { arr = window.highway?.getSongInfo?.()?.arrangement || window.feedBack?.currentSong?.arrangement || ''; } catch (_) {}
    return { sc: Math.max(1, Math.min(8, sc)), isBass: /bass/i.test(String(arr)) };
}

// Normalize an arbitrary value to a slot→hex map of validated lowercase colors
// (absent / invalid slots are omitted).
function _hwcNormalize(slotMap) {
    const out = {};
    if (slotMap && typeof slotMap === 'object' && !Array.isArray(slotMap)) {
        for (const k of HWC_SLOT_KEYS) {
            const v = (typeof slotMap[k] === 'string') ? slotMap[k].trim().toLowerCase() : '';
            if (HWC_HEX_RE.test(v)) out[k] = v;
        }
    }
    return out;
}

// Canonical default color per named slot (the classic highway mapping).
// Fixed, not read back from the highway (which may already be name-remapped for
// a 7/8-string chart), so the pickers always preview the true per-name default.
function getHighwayDefaultSlotColors() {
    return { ...HWC_DEFAULT_FALLBACK };
}

// Active (user-customized) slot→hex map from storage ({} when none set).
function getHighwayStringColors() {
    try {
        const raw = localStorage.getItem(HWC_KEY_ACTIVE);
        if (raw) return _hwcNormalize(JSON.parse(raw));
    } catch (_) { /* corrupt / blocked */ }
    return {};
}

// Defaults overlaid with the user's custom slots (custom wins). Always a full
// 8-slot map, so name-mapping has a color for every string of any arrangement.
function _hwcMergedSlotColors() {
    return { ...getHighwayDefaultSlotColors(), ...getHighwayStringColors() };
}

// True when the slot→index mapping is the identity (index 0 = lowest = Low E):
// guitar ≤6 strings and 4-string bass. For these the name mapping equals the
// stock index order, so we leave the highways on their hand-tuned defaults
// (byte-identical) unless the user set custom colors. Extended-range charts —
// 7/8-string guitar and 5/6-string bass — prepend lower strings (Low B/F#),
// shifting Low E up an index, so their defaults must be name-remapped too.
function _hwcMappingIsIdentity(sc, isBass) {
    return isBass ? sc <= 4 : sc <= 6;
}

// Translate a full slot map into the index-keyed array the highways consume.
function _hwcEffectiveIndexColors(slotMap, sc, isBass) {
    const keys = _hwcSlotKeysForChart(sc, isBass);
    return keys.map((k) => slotMap[k] || null);
}

// Persist the user's custom slot map (or clear it), then apply. Only slots that
// actually DIFFER from the default are stored — so reverting every picker to its
// stock color persists as empty and the identity/stock path is restored (rather
// than pinning the highways on an all-default "custom" theme).
function applyHighwayStringColors(slotMap, opts) {
    const persist = !opts || opts.persist !== false;
    const colors = _hwcNormalize(slotMap);
    const defaults = getHighwayDefaultSlotColors();
    const overrides = {};
    for (const k of Object.keys(colors)) {
        if (colors[k] !== defaults[k]) overrides[k] = colors[k];
    }
    if (persist) {
        try {
            if (Object.keys(overrides).length) localStorage.setItem(HWC_KEY_ACTIVE, JSON.stringify(overrides));
            else localStorage.removeItem(HWC_KEY_ACTIVE);
        } catch (_) {}
    }
    reapplyHighwayStringColors();
}

// Apply a named one-click string-color preset (see HWC_PRESETS) to all strings.
// Persists + applies to both highways (via applyHighwayStringColors), then —
// when the Settings UI is mounted — refreshes the per-string pickers so their
// swatches show the preset's colors. Unknown id is a no-op.
function applyHighwayStringPreset(id) {
    const preset = HWC_PRESETS.find((p) => p.id === id);
    if (!preset) return false;
    applyHighwayStringColors(preset.colors);
    try { if (typeof hwcRenderPickers === 'function') hwcRenderPickers(); } catch (_) {}
    return true;
}

// Apply colors by NAMED string to both highways for the current arrangement.
// Colors follow the string name regardless of count: Low E stays Low E's color
// on a 6-, 7-, or 8-string. Defaults map identically to the stock order for
// 6-string/bass (so those stay byte-identical); 7/8-string remaps the defaults
// too so Low E keeps its color. The String Colors UI replaces the 3D highway's
// old palette picker, so core always drives the 3D string colors here.
function reapplyHighwayStringColors() {
    const { sc, isBass } = _hwcChartShape();
    const custom = getHighwayStringColors();
    const hasCustom = Object.keys(custom).length > 0;

    if (!hasCustom && _hwcMappingIsIdentity(sc, isBass)) {
        // Pure stock defaults in natural order — leave the hand-tuned highway
        // defaults intact, and make sure the 3D is on its plain default palette
        // (clears any stale 'custom' / leftover palette selection).
        try { window.highway?.setStringColors?.(null); } catch (_) {}
        try {
            if (localStorage.getItem('h3d_bg_palette') !== 'default') window.h3dBgSetPalette?.('default');
        } catch (_) {}
        try { window.feedBack?.emit?.('highway:stringColors', {}); } catch (_) {}
        return;
    }

    const eff = _hwcEffectiveIndexColors(_hwcMergedSlotColors(), sc, isBass);
    try { window.highway?.setStringColors?.(eff); } catch (_) {}
    try { window.h3dBgSetStringColors?.(eff); } catch (_) {}
    try { window.feedBack?.emit?.('highway:stringColors', custom); } catch (_) {}
}

function _hwcReadThemes() {
    // Null-prototype store: theme names come from user input / share codes, so
    // names like `constructor`/`toString`/`__proto__` must not collide with
    // inherited Object properties or mutate the prototype.
    try {
        const parsed = JSON.parse(localStorage.getItem(HWC_KEY_THEMES) || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return Object.create(null);
        const out = Object.create(null);
        for (const [name, colors] of Object.entries(parsed)) out[name] = _hwcNormalize(colors);
        return out;
    } catch (_) { return Object.create(null); }
}
function _hwcWriteThemes(o) { try { localStorage.setItem(HWC_KEY_THEMES, JSON.stringify(o)); } catch (_) {} }
function listHighwayColorThemes() { return Object.keys(_hwcReadThemes()); }
function getActiveHighwayColorThemeName() { try { return localStorage.getItem(HWC_KEY_NAME) || ''; } catch (_) { return ''; } }

function saveHighwayColorTheme(name, slotMap) {
    name = String(name || '').trim();
    if (!name) return false;
    const o = _hwcReadThemes();
    o[name] = _hwcNormalize(slotMap);
    _hwcWriteThemes(o);
    try { localStorage.setItem(HWC_KEY_NAME, name); } catch (_) {}
    return true;
}
function deleteHighwayColorTheme(name) {
    const o = _hwcReadThemes();
    if (Object.prototype.hasOwnProperty.call(o, name)) { delete o[name]; _hwcWriteThemes(o); }
    if (getActiveHighwayColorThemeName() === name) { try { localStorage.removeItem(HWC_KEY_NAME); } catch (_) {} }
}
// Select a saved theme by name, or pass '' to revert to defaults.
function selectHighwayColorTheme(name) {
    if (!name) {
        try { localStorage.removeItem(HWC_KEY_NAME); } catch (_) {}
        applyHighwayStringColors(null);
        return;
    }
    const o = _hwcReadThemes();
    if (!Object.prototype.hasOwnProperty.call(o, name)) return;
    try { localStorage.setItem(HWC_KEY_NAME, name); } catch (_) {}
    applyHighwayStringColors(o[name]);
}

// Compact, paste-friendly share code: "SLOPHWY2." + base64url(JSON{n,c}) where
// c is the named slot→hex map.
function encodeHighwayColorShare(name, slotMap) {
    const payload = { n: String(name || '').slice(0, 60), c: _hwcNormalize(slotMap) };
    const json = JSON.stringify(payload);
    let b64;
    try { b64 = btoa(unescape(encodeURIComponent(json))); } catch (_) { b64 = btoa(json); }
    return 'SLOPHWY2.' + b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeHighwayColorShare(code) {
    if (typeof code !== 'string') return null;
    let s = code.trim();
    // Require the exact versioned prefix. Anything else (a future/legacy
    // SLOPHWY*, or unprefixed text) is rejected so the version boundary is real.
    const PREFIX = 'SLOPHWY2.';
    if (s.slice(0, PREFIX.length).toUpperCase() !== PREFIX) return null;
    s = s.slice(PREFIX.length);
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    let json;
    try { json = decodeURIComponent(escape(atob(s))); } catch (_) { try { json = atob(s); } catch (_) { return null; } }
    let obj;
    try { obj = JSON.parse(json); } catch (_) { return null; }
    if (!obj || typeof obj.c !== 'object' || Array.isArray(obj.c)) return null;
    return { name: String(obj.n || '').slice(0, 60), colors: _hwcNormalize(obj.c) };
}
// Import a share code: store it as a (uniquely named) saved theme and apply.
function importHighwayColorShare(code) {
    const parsed = decodeHighwayColorShare(code);
    if (!parsed) return null;
    let name = parsed.name || 'Imported';
    const existing = _hwcReadThemes();
    if (Object.prototype.hasOwnProperty.call(existing, name)) {
        let i = 2;
        while (Object.prototype.hasOwnProperty.call(existing, name + ' ' + i)) i++;
        name = name + ' ' + i;
    }
    saveHighwayColorTheme(name, parsed.colors);
    applyHighwayStringColors(parsed.colors);
    return { name, colors: parsed.colors };
}

// Startup: apply persisted colors to the 2D highway immediately and re-apply on
// every song load (string count / bass-vs-guitar can change the slot→index
// mapping) and whenever a viz renderer (re)initializes (the 3D loads async +
// rebuilds per song, so a one-shot apply could land before it exists).
let _hwcWired = false;
export function initHighwayColors() {
    reapplyHighwayStringColors();
    if (!_hwcWired && window.feedBack && typeof window.feedBack.on === 'function') {
        _hwcWired = true;
        window.feedBack.on('viz:renderer:ready', reapplyHighwayStringColors);
        window.feedBack.on('song:loaded', reapplyHighwayStringColors);
        window.feedBack.on('song:ready', reapplyHighwayStringColors);
    }
    _hwcInstallFacade();
}

// ── Public plugin API: window.feedBack.highwayColors ─────────────────────
// A stable, documented facade over the (otherwise private) string-color
// manager so plugins can read / react to / set the user's per-string colors
// without reaching into internals. This is a synchronous data-plane API, not a
// capability domain — consistent with the constitution keeping highway/viz
// surfaces off the capability graph until a dedicated render-facade slice
// lands. Colors are keyed by NAMED string slot (see `slots`); use
// `keysForChart`/`toEffective` to map names → per-string-index for a given
// arrangement. See docs/plugin-capability-inventory.md.
const _hwcChangeWrappers = new WeakMap();
function _hwcInstallFacade() {
    if (!window.feedBack || window.feedBack.highwayColors) return;
    const api = {
        version: 1,
        // Ordered named slots: [{ key, label, sub }]. `key` is the stable id.
        slots: HWC_SLOTS.map((s) => ({ key: s.key, label: s.label, sub: s.sub })),
        // User-set overrides only (named slot → hex); empty object = defaults.
        get() { return getHighwayStringColors(); },
        // Canonical default color per named slot.
        getDefaults() { return getHighwayDefaultSlotColors(); },
        // Defaults overlaid with overrides — the colors in effect, by name.
        getResolved() { return _hwcMergedSlotColors(); },
        // Which named slot each chart string index maps to, for an arrangement
        // (index 0 = lowest string). e.g. (7,false) → ['low7','lowE','A',...].
        keysForChart(stringCount, isBass) { return _hwcSlotKeysForChart(stringCount, !!isBass); },
        // Per-string-INDEX hex array (resolved colors) for an arrangement.
        // Omit args to use the currently-loaded chart's shape.
        toEffective(stringCount, isBass) {
            const shape = (typeof stringCount === 'number')
                ? { sc: stringCount, isBass: !!isBass }
                : _hwcChartShape();
            return _hwcEffectiveIndexColors(_hwcMergedSlotColors(), shape.sc, shape.isBass);
        },
        // The per-index colors actually applied to the live 2D highway now.
        getCurrent() {
            try { return (window.highway && window.highway.getStringColors) ? window.highway.getStringColors() : []; }
            catch (_) { return []; }
        },
        // Set colors programmatically (persists + applies to both highways).
        // Pass a named slot map, or null/{} to revert to defaults.
        apply(slotMap) { return applyHighwayStringColors(slotMap); },
        // One-click presets: [{ id, label, colors }] (full named-slot maps).
        presets: HWC_PRESETS.map((p) => ({ id: p.id, label: p.label, colors: { ...p.colors } })),
        // Apply a preset by id (persists + applies to both highways).
        applyPreset(id) { return applyHighwayStringPreset(id); },
        // Share-code interop (the "SLOPHWY2." copy/paste format).
        encodeShare(name, slotMap) { return encodeHighwayColorShare(name, slotMap); },
        decodeShare(code) { return decodeHighwayColorShare(code); },
        // Subscribe to color changes; handler receives the resolved slot map.
        // Returns an unsubscribe fn that removes exactly THIS subscription;
        // offChange(fn) removes every subscription registered with that fn.
        // (Each fn maps to a Set of wrappers so repeated mount/init paths that
        // subscribe the same handler don't clobber each other or leak.)
        onChange(fn) {
            if (typeof fn !== 'function' || !window.feedBack) return () => {};
            const wrapper = () => {
                try { fn(api.getResolved()); } catch (e) { console.error('[highwayColors] onChange handler threw', e); }
            };
            let set = _hwcChangeWrappers.get(fn);
            if (!set) { set = new Set(); _hwcChangeWrappers.set(fn, set); }
            set.add(wrapper);
            window.feedBack.on('highway:stringColors', wrapper);
            return () => {
                if (window.feedBack) window.feedBack.off('highway:stringColors', wrapper);
                const s = _hwcChangeWrappers.get(fn);
                if (s) { s.delete(wrapper); if (!s.size) _hwcChangeWrappers.delete(fn); }
            };
        },
        offChange(fn) {
            const set = _hwcChangeWrappers.get(fn);
            if (set && window.feedBack) {
                for (const wrapper of set) window.feedBack.off('highway:stringColors', wrapper);
                _hwcChangeWrappers.delete(fn);
            }
        },
    };
    window.feedBack.highwayColors = api;
}

// ── Highway String Colors — Settings UI wiring ───────────────────────────
// Pickers are per NAMED string (see HWC_SLOTS). Assigning "Low E" a color
// keeps Low E that color regardless of string count — the translation table
// (_hwcSlotKeysForChart) handles the index remapping per arrangement.

function _hwcStatus(msg) {
    const el = document.getElementById('hwc-status');
    if (!el) return;
    el.textContent = msg || '';
    if (msg) {
        clearTimeout(_hwcStatus._t);
        _hwcStatus._t = setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 2500);
    }
}

// Render one color input per named slot, seeded from active colors (falling
// back to the highway defaults for that slot).
function hwcRenderPickers() {
    const host = document.getElementById('hwc-pickers');
    if (!host) return;
    const defaults = getHighwayDefaultSlotColors();
    const active = getHighwayStringColors();
    host.innerHTML = '';
    for (const slot of HWC_SLOTS) {
        const val = active[slot.key] || defaults[slot.key] || '#888888';
        const wrap = document.createElement('label');
        wrap.className = 'flex items-center gap-2 text-xs text-gray-400';
        const input = document.createElement('input');
        input.type = 'color';
        input.id = 'hwc-color-' + slot.key;
        input.dataset.slot = slot.key;
        input.value = val;
        input.style.width = '2.5rem';
        input.style.height = '1.75rem';
        input.style.padding = '2px';
        input.style.cursor = 'pointer';
        input.className = 'rounded border border-gray-800 bg-dark-700';
        input.addEventListener('input', () => hwcOnColorInput());
        wrap.appendChild(input);
        const span = document.createElement('span');
        span.textContent = slot.label;
        wrap.appendChild(span);
        const sub = document.createElement('span');
        sub.className = 'text-gray-600';
        sub.textContent = slot.sub;
        wrap.appendChild(sub);
        host.appendChild(wrap);
    }
}

function hwcReadPickers() {
    const out = {};
    for (const slot of HWC_SLOTS) {
        const el = document.getElementById('hwc-color-' + slot.key);
        if (el) out[slot.key] = el.value;
    }
    return out;
}

// Live apply on any picker change. Leaves the saved-theme select alone so a
// tweaked-but-unsaved state is allowed; "Save as…" captures it.
function hwcOnColorInput() {
    applyHighwayStringColors(hwcReadPickers());
}

function hwcPopulateThemeSelect() {
    const sel = document.getElementById('hwc-theme-select');
    if (!sel) return;
    const names = listHighwayColorThemes().sort((a, b) => a.localeCompare(b));
    const current = getActiveHighwayColorThemeName();
    sel.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = 'Default colors';
    sel.appendChild(def);
    for (const n of names) {
        const opt = document.createElement('option');
        opt.value = n;
        opt.textContent = n;
        sel.appendChild(opt);
    }
    sel.value = (current && names.includes(current)) ? current : '';
}

function hwcOnSelectTheme(name) {
    selectHighwayColorTheme(name);
    hwcRenderPickers();
}

async function hwcSaveTheme() {
    const name = await uiPrompt({ title: 'Save Highway Colors', label: 'Theme name', value: getActiveHighwayColorThemeName() || 'My Colors', okLabel: 'Save' });
    if (!name) return;
    saveHighwayColorTheme(name, hwcReadPickers());
    hwcPopulateThemeSelect();
    _hwcStatus('Saved “' + name + '”');
}

function hwcDeleteTheme() {
    const name = getActiveHighwayColorThemeName();
    if (!name) { _hwcStatus('No saved theme selected'); return; }
    deleteHighwayColorTheme(name);
    applyHighwayStringColors(null);
    hwcPopulateThemeSelect();
    hwcRenderPickers();
    _hwcStatus('Deleted “' + name + '”');
}

function hwcReset() {
    try { localStorage.removeItem(HWC_KEY_NAME); } catch (_) {}
    applyHighwayStringColors(null);
    hwcPopulateThemeSelect();
    hwcRenderPickers();
    _hwcStatus('Reset to defaults');
}

async function hwcCopyShare() {
    const name = getActiveHighwayColorThemeName() || 'Highway Colors';
    const code = encodeHighwayColorShare(name, hwcReadPickers());
    let copied = false;
    try { await navigator.clipboard.writeText(code); copied = true; } catch (_) {}
    if (!copied) {
        // Fallback: drop the code into the import field so it can be copied manually.
        const inp = document.getElementById('hwc-import-code');
        if (inp) { inp.value = code; inp.select(); }
    }
    _hwcStatus(copied ? 'Share code copied' : 'Copy failed — code shown below');
}

function hwcImport() {
    const inp = document.getElementById('hwc-import-code');
    const code = inp ? inp.value : '';
    const res = importHighwayColorShare(code);
    if (!res) { _hwcStatus('Invalid share code'); return; }
    if (inp) inp.value = '';
    hwcPopulateThemeSelect();
    hwcRenderPickers();
    _hwcStatus('Imported “' + res.name + '”');
}

export function hwcInitSettingsUI() {
    hwcPopulateThemeSelect();
    hwcRenderPickers();
}
