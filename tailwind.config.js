/**
 * Tailwind CSS build config for feedBack core.
 *
 * Replaces the Play CDN (`cdn.tailwindcss.com`) JIT runtime that
 * previously scanned the DOM ~1.8x/sec on the main thread, causing
 * sustained frame drops with the 3D highway. See feedBack-desktop#110.
 *
 * Regenerate `static/tailwind.min.css` with:
 *   bash scripts/build-tailwind.sh
 *
 * The generated CSS is committed; there is no build step at serve time.
 */
module.exports = {
    content: [
        './static/**/*.{html,js}',
        // fee[dB]ack v0.3.0 shell + screens (additive, behind FEEDBACK_UI=v3).
        // Subsumed by the recursive ./static/** glob above, but listed
        // explicitly so the v3 tree's Tailwind coverage is obvious.
        './static/v3/**/*.{html,js}',
        // One recursive plugin glob subsumes the previous four narrow ones
        // (static/**, screen.js, settings.html, *.html) and additionally
        // scans plugin .js files that aren't screen.js (e.g.
        // plugins/app_tour_*/script.js), closing a silent coverage hole.
        './plugins/**/*.{js,html}',
        // highway_3d owns its styles via the `styles` capability (it ships
        // plugins/highway_3d/assets/plugin.css, preflight off), so core no
        // longer scans it — its arbitrary values live in its own sheet, not
        // core's. Pilot for decentralizing all bundled plugins' CSS.
        '!./plugins/highway_3d/**',
    ],
    theme: {
        extend: {
            colors: {
                dark: { 900: '#050508', 800: '#0a0a12', 700: '#10101e', 600: '#181830', 500: '#1e1e3a' },
                accent: { DEFAULT: '#4080e0', light: '#60a0ff', dark: '#2060b0' },
                gold: '#e8c040',
                // fee[dB]ack v0.3.0 palette (additive). Namespaced under `fb`
                // so it never clashes with the legacy `accent`/`dark`/`gold`
                // tokens the 0.2.9 stylesheet still builds against.
                // See ~/Repositories/feedBack-feedback-v030/design/01-design-system.md §1.
                fb: {
                    bg: '#0f172a',        // app background (navy)
                    sidebar: '#111827',   // sidebar
                    card: '#1e293b',      // cards / panels
                    cardMuted: '#0b1220', // inset wells
                    primary: '#0ea5e9',   // sky — primary actions, active nav, progress fill
                    primaryHi: '#38bdf8', // hover
                    accent: '#ef4444',    // red — destructive, low-accuracy
                    text: '#f8fafc',      // primary text
                    textDim: '#94a3b8',   // secondary text
                    border: '#334155',    // hairlines / card borders
                    good: '#22c55e',      // accuracy >=90%
                    mid: '#eab308',       // accuracy 50-89%
                    low: '#ef4444',       // accuracy <50%
                    gold: '#e8c040',      // mastery accent retained from legacy palette
                },
            },
            fontFamily: {
                // Shared token used by BOTH the v2 (legacy) and v3 bodies. Keep it
                // Inter so the default v2 UI is unchanged; v3 overrides font-display
                // to Rubik in static/v3/v3.css (loaded only by the v3 page).
                display: ['"Inter"', 'system-ui', 'sans-serif'],
            },
        },
    },
    safelist: [
        // Dynamically-built class names that don't appear textually in
        // any source file the content globs cover.
        { pattern: /^(bg|text|border|ring)-(red|green|amber|yellow|blue|indigo|purple|pink|gray|slate)-(50|100|200|300|400|500|600|700|800|900)$/ },
        { pattern: /^(bg|text|border)-(dark|accent)(-.+)?$/ },
        'text-gold', 'bg-gold', 'border-gold',
    ],
    plugins: [],
};
