/**
 * Tailwind build config for the 3D Highway plugin's OWN stylesheet.
 *
 * FeedBack serves Tailwind as a prebuilt stylesheet and core only scans core
 * source at build time (constitution Principle II — no Play CDN / runtime JIT).
 * This plugin owns its utilities so it styles correctly even when core's build
 * didn't scan it (it's excluded from core's content globs). It uses arbitrary
 * values (`text-[10px]`, `max-w-[12rem]`) that no "complete" Tailwind set
 * contains, so a self-built, content-scanned sheet is mandatory.
 *
 * Regenerate assets/plugin.css with:  bash build-tailwind.sh
 */
module.exports = {
    // Core ships the single base reset; this plugin emits utilities only so it
    // doesn't double the preflight and fight core's styles.
    corePlugins: { preflight: false },
    content: [
        // List only the files that carry Tailwind classes — screen.js (renderer
        // + HUD markup) and settings.html. A broad ./*.{js,html} would also scan
        // THIS config (its comments mention class-like strings such as
        // text-[10px]) and emit them spuriously; tour.json is plain text.
        './screen.js',
        './settings.html',
    ],
    theme: {
        extend: {
            // Mirror core's theme tokens so classes like `bg-dark-700` compile
            // inside this standalone build.
            colors: {
                dark: { 900: '#050508', 800: '#0a0a12', 700: '#10101e', 600: '#181830', 500: '#1e1e3a' },
                accent: { DEFAULT: '#4080e0', light: '#60a0ff', dark: '#2060b0' },
                gold: '#e8c040',
            },
            fontFamily: {
                display: ['"Inter"', 'system-ui', 'sans-serif'],
            },
        },
    },
    // Belt-and-suspenders for any dark/accent class built indirectly (none are
    // today — all usage is literal — but this keeps the sheet self-sufficient).
    safelist: [
        { pattern: /^(bg|text|border)-(dark|accent)(-.+)?$/ },
    ],
    plugins: [],
};
