/*
 * fee[dB]ack v0.3.0 — cosmetics applier (spec 010): shop themes + avatar frames.
 *
 * Replicates the proven plugins/themes CSS-variable pattern for the v3 `fb-*`
 * palette: one injected <style> re-points the fb utility classes at
 * `--fbv-*` variables under an `html[data-fb-theme]` gate, so the default
 * look is untouched until a theme is equipped and "unequip" is just removing
 * the attribute. No Tailwind build interaction (constitution P-II) — rules
 * are generated at runtime from the equipped item's color payload.
 *
 * Loads BEFORE profile.js so the equipped theme + avatar frame apply with the
 * first badge render (equipped cosmetics ride along on GET /api/profile).
 * Decorative accents (rings, shadows, placeholder tints) deliberately keep
 * their defaults — themes recolor surfaces, text, and borders.
 */
(function () {
    'use strict';
    const STYLE_ID = 'fb-theme-style';
    // Mirrors the `fb` palette in tailwind.config.js.
    const KEYS = ['bg', 'sidebar', 'card', 'cardMuted', 'primary', 'primaryHi', 'accent',
                  'text', 'textDim', 'border', 'good', 'mid', 'low', 'gold'];
    // Opacity suffixes used by v3 markup (bg-fb-card/80, border-fb-border/50, …).
    const OPACITY = { 95: '0.95', 90: '0.9', 80: '0.8', 70: '0.7', 60: '0.6',
                      50: '0.5', 40: '0.4', 30: '0.3', 20: '0.2', 10: '0.1' };

    let _frameStyle = '';   // equipped avatar-frame CSS fragment ('' = none)

    function hexToRgb(hex) {
        const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
        if (!m) return null;
        const n = parseInt(m[1], 16);
        return ((n >> 16) & 255) + ' ' + ((n >> 8) & 255) + ' ' + (n & 255);
    }

    function cssFor(colors) {
        let vars = '';
        let rules = '';
        for (const key of KEYS) {
            const rgb = hexToRgb(colors[key]);
            if (!rgb) continue;
            vars += '  --fbv-' + key + ': ' + rgb + ';\n';
            const v = 'var(--fbv-' + key + ')';
            rules +=
                'html[data-fb-theme] .bg-fb-' + key + ' { background-color: rgb(' + v + '); }\n' +
                'html[data-fb-theme] .hover\\:bg-fb-' + key + ':hover { background-color: rgb(' + v + '); }\n' +
                'html[data-fb-theme] .text-fb-' + key + ' { color: rgb(' + v + '); }\n' +
                'html[data-fb-theme] .hover\\:text-fb-' + key + ':hover { color: rgb(' + v + '); }\n' +
                'html[data-fb-theme] .border-fb-' + key + ' { border-color: rgb(' + v + '); }\n';
            for (const suffix in OPACITY) {
                const op = OPACITY[suffix];
                rules +=
                    'html[data-fb-theme] .bg-fb-' + key + '\\/' + suffix + ' { background-color: rgb(' + v + ' / ' + op + '); }\n' +
                    'html[data-fb-theme] .text-fb-' + key + '\\/' + suffix + ' { color: rgb(' + v + ' / ' + op + '); }\n' +
                    'html[data-fb-theme] .border-fb-' + key + '\\/' + suffix + ' { border-color: rgb(' + v + ' / ' + op + '); }\n' +
                    'html[data-fb-theme] .divide-fb-' + key + '\\/' + suffix + ' > :not([hidden]) ~ :not([hidden]) { border-color: rgb(' + v + ' / ' + op + '); }\n';
            }
        }
        // The app shell paints body via bg-fb-sidebar (covered above); cover a
        // bare body too so the radial-gradient fallback areas follow the theme.
        rules += 'html[data-fb-theme] body { background-color: rgb(var(--fbv-sidebar)); color: rgb(var(--fbv-text)); }\n';
        // The sidebar's navy radial wash is hardcoded in v3.css (#v3-sidebar)
        // and carries NO fb-* utility class, so the per-utility loop above
        // can't reach it — it stayed navy under every theme, the most visible
        // "backgrounds don't change" gap. Re-point it at the theme, mirroring
        // v3.css's stops (#1e293b == default card, #0f172a == default bg).
        // Only background-image is overridden, so background-attachment:fixed
        // from v3.css is preserved. Gated by [data-fb-theme] => default look
        // untouched. (Scroll-thumb colors are deliberately left alone: theming
        // the resting thumb would out-specify v3.css's :hover lighten rule and
        // kill it, and there's no palette token between border and textDim to
        // reproduce the hover shade without color-mix, unused here.)
        rules += 'html[data-fb-theme] #v3-sidebar { background-image: radial-gradient(circle at top, rgb(var(--fbv-card)) 0%, rgb(var(--fbv-bg)) 100%); }\n';
        return 'html[data-fb-theme] {\n' + vars + '}\n' + rules;
    }

    function apply(payload) {
        const colors = payload && payload.colors;
        let styleEl = document.getElementById(STYLE_ID);
        if (!colors) {
            if (styleEl) styleEl.remove();
            document.documentElement.removeAttribute('data-fb-theme');
            return;
        }
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = STYLE_ID;
            document.head.appendChild(styleEl);
        }
        styleEl.textContent = cssFor(colors);
        document.documentElement.setAttribute('data-fb-theme', '1');
    }

    function setFrame(payload) {
        // Bundled-content trust model; still keep it attribute-safe (it is set
        // via element.style, never innerHTML).
        _frameStyle = String((payload && payload.frame_style) || '').replace(/[{}<>]/g, '');
    }

    // Apply the equipped frame to an avatar wrapper element (badge, profile,
    // Progress). Always resets first so unequip clears previous frames.
    function applyFrame(el) {
        if (!el) return;
        el.style.boxShadow = '';
        if (_frameStyle) el.style.cssText += ';' + _frameStyle + ';';
    }

    function applyCosmetics(cosmetics) {
        cosmetics = cosmetics || {};
        apply((cosmetics.theme || {}).payload || null);
        setFrame((cosmetics.avatar_frame || {}).payload || null);
    }

    async function refresh() {
        try {
            const r = await fetch('/api/profile');
            if (r.ok) {
                const profile = await r.json();
                applyCosmetics(profile.cosmetics);
                if (window.feedBack && typeof window.feedBack.emit === 'function') {
                    window.feedBack.emit('v3:cosmetics-applied', profile.cosmetics || {});
                }
            }
        } catch (e) { /* offline — keep current look */ }
    }

    window.v3Theme = {
        apply,            // preview/apply a theme payload directly (null = default)
        applyCosmetics,   // apply a {theme, avatar_frame} equipped map
        applyFrame,       // decorate an avatar wrapper with the equipped frame
        frameStyle: () => _frameStyle,
        refresh,          // re-read equipped cosmetics from /api/profile
    };

    refresh();
    // Re-apply when an equip/unequip happens anywhere (shop screen, capability
    // command from a plugin).
    if (window.feedBack && typeof window.feedBack.on === 'function') {
        window.feedBack.on('progression:cosmetic-equipped', refresh);
    }
})();
