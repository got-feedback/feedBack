// Perf-baseline harness for the module-migration refactor (R0).
//
// Rerun this after every phase (R0 → R3c) to prove the split does not regress
// screen-entry, frame-time, memory, or server latency. It writes a markdown
// results block to stdout; paste it into docs/perf-baseline.md (or redirect).
//
// Usage:
//   node scripts/perf-baseline.mjs --base http://127.0.0.1:8000 [--n 60] [--soak 30]
//   node scripts/perf-baseline.mjs --base http://127.0.0.1:8300 --song "Arcturus ….feedpak"
//
// With --song, it additionally measures the 2D highway's PER-FRAME DRAW cost:
// it wraps requestAnimationFrame before any page script runs, tags the frames
// in which the highway actually painted (via highway.addDrawHook), starts
// playback, and reports draw-frame p50/p95/p99 over --frames seconds. Tagging
// matters — roughly half the rAF callbacks belong to other cheap loops, and
// averaging them in hides a renderer regression behind ~0.1 ms no-op frames.
// This is the metric that gates the highway.js split (R3c); run it before AND
// after each highway change on the same machine.
//
// Maintainer/CI-only dev tooling (uses the committed @playwright/test browser);
// never part of the serve or Docker path. Metrics that need a seeded library
// with charts (playback frame-time, screen-entry into a live highway) are
// clearly labelled — run those against an environment with real songs.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const BASE = args.get('base') || 'http://127.0.0.1:8000';
const N = parseInt(args.get('n') || '60', 10);
const SOAK_S = parseInt(args.get('soak') || '30', 10);
const SONG = args.get('song') || null;
const FRAME_S = parseInt(args.get('frames') || '10', 10);
const RUNS = parseInt(args.get('runs') || '3', 10);   // repeat frame sampling to show spread

const pct = (xs, p) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const ms = (x) => (x == null ? '—' : `${x.toFixed(1)}`);

// ── Server latency: p50/p95/p99 over N requests per endpoint ──────────────────
async function serverLatency(paths) {
    const rows = [];
    for (const path of paths) {
        const t = [];
        let status = 0;
        for (let i = 0; i < N; i++) {
            const t0 = performance.now();
            try {
                const r = await fetch(BASE + path);
                status = r.status;
                await r.arrayBuffer();
            } catch { status = -1; }
            t.push(performance.now() - t0);
        }
        rows.push({ path, status, p50: pct(t, 50), p95: pct(t, 95), p99: pct(t, 99) });
    }
    return rows;
}

// ── Client: cold boot-to-interactive + idle memory after a soak ───────────────
async function clientMetrics() {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const t0 = Date.now();
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
    const bootMs = Date.now() - t0;

    // performance.memory is Chromium-only; JS heap after settle.
    const mem0 = await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : null));
    await page.waitForTimeout(SOAK_S * 1000);
    const mem1 = await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : null));

    const scripts = await page.evaluate(() =>
        document.querySelectorAll('script[data-plugin-id]').length);

    await browser.close();
    return { bootMs, memStartMB: mem0 && mem0 / 1048576, memSoakMB: mem1 && mem1 / 1048576, scripts };
}

// ── 2D highway per-frame draw cost (needs --song + a seeded library) ──────────
async function frameTimeOnce(browser) {
    const page = await browser.newPage();
    let f, t2, notes;
    try {
        // Wrap rAF before any page script; mark frames the highway actually drew.
        await page.addInitScript(() => {
            window.__f = [];
            window.__drew = false;
            const raf = window.requestAnimationFrame.bind(window);
            window.requestAnimationFrame = (cb) => raf((t) => {
                window.__drew = false;
                const t0 = performance.now();
                try { cb(t); } finally { window.__f.push({ ms: performance.now() - t0, drew: window.__drew }); }
            });
        });
        await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
        await page.evaluate(() => document.getElementById('v3-onboarding')?.remove());
        await page.evaluate((s) => window.playSong(s), SONG);
        await page.waitForFunction(() => (window.highway?.getNotes?.() || []).length >= 0 && window.highway?.getSongInfo?.(),
            null, { timeout: 45000 }).catch(() => {});
        await page.waitForFunction(() => (window.highway?.getNotes?.() || []).length > 0, null, { timeout: 45000 });
        await page.evaluate(() => window.highway.addDrawHook(() => { window.__drew = true; }));
        // Start playback so draw() leaves its paused-throttle path; confirm the clock advances.
        await page.evaluate(async () => { const a = window.highway.getAudioElement?.(); if (a) a.muted = true; await a?.play?.(); });
        await page.waitForTimeout(1500);
        const t1 = await page.evaluate(() => window.highway.getTime());
        await page.evaluate(() => { window.__f.length = 0; });
        await page.waitForTimeout(FRAME_S * 1000);
        ({ f, t2, notes } = await page.evaluate(() => ({
            f: window.__f.slice(), t2: window.highway.getTime(), notes: window.highway.getNotes().length,
        })));
        if (!(t2 > t1 + 1)) throw new Error(`clock did not advance (${t1}→${t2}) — measured the paused path`);
    } finally {
        // Always close, even when an await above throws — otherwise a failing
        // run leaks its page until the final browser.close().
        await page.close();
    }
    const drew = f.filter((x) => x.drew).map((x) => x.ms);
    return { drew, total: f.length, notes };
}

async function frameTime() {
    const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    const rows = [];
    for (let i = 0; i < RUNS; i++) {
        try {
            const r = await frameTimeOnce(browser);
            rows.push({
                p50: pct(r.drew, 50), p95: pct(r.drew, 95), p99: pct(r.drew, 99),
                max: Math.max(...r.drew), n: r.drew.length, total: r.total, notes: r.notes,
            });
        } catch (e) { rows.push({ error: String(e.message || e) }); }
    }
    await browser.close();
    return rows;
}

const server = await serverLatency([
    '/api/version',
    '/api/plugins',
    '/api/library?limit=60',
    '/api/library/artists',
]);
const client = await clientMetrics();

const now = new Date().toISOString();
let out = `\n<!-- generated by scripts/perf-baseline.mjs @ ${now} against ${BASE} (n=${N}, soak=${SOAK_S}s) -->\n\n`;
out += `### Server latency (ms)\n\n| Endpoint | status | p50 | p95 | p99 |\n|---|---|---|---|---|\n`;
for (const r of server) out += `| \`${r.path}\` | ${r.status} | ${ms(r.p50)} | ${ms(r.p95)} | ${ms(r.p99)} |\n`;
out += `\n### Client\n\n| Metric | Value |\n|---|---|\n`;
out += `| Cold boot → networkidle | ${client.bootMs} ms |\n`;
out += `| JS heap after load | ${client.memStartMB ? client.memStartMB.toFixed(1) + ' MB' : '—'} |\n`;
out += `| JS heap after ${SOAK_S}s idle soak | ${client.memSoakMB ? client.memSoakMB.toFixed(1) + ' MB' : '—'} |\n`;
out += `| Plugin scripts injected | ${client.scripts} |\n`;
if (SONG) {
    const frames = await frameTime();
    out += `\n### 2D highway per-frame draw cost — \`${SONG}\` (${RUNS} runs × ${FRAME_S}s)\n\n`;
    out += `| run | draw frames | p50 | p95 | p99 | max |\n|---|---|---|---|---|---|\n`;
    for (let i = 0; i < frames.length; i++) {
        const r = frames[i];
        if (r.error) { out += `| ${i + 1} | — | \`${r.error}\` | | | |\n`; continue; }
        out += `| ${i + 1} | ${r.n}/${r.total} | ${ms(r.p50)} | ${ms(r.p95)} | ${ms(r.p99)} | ${ms(r.max)} |\n`;
    }
    const p95s = frames.filter((r) => !r.error).map((r) => r.p95);
    if (p95s.length) out += `\n**p95 spread across runs: ${ms(Math.min(...p95s))}–${ms(Math.max(...p95s))} ms**\n`;
} else {
    out += `\n> **Requires a seeded library** (not captured by this run): playback frame-time p95\n`;
    out += `> on the 2D highway — pass \`--song "<filename in DLC_DIR>"\` to capture it.\n`;
    out += `> (3D highway_3d + screen-entry timings are a separate R4 concern.)\n`;
}

console.log(out);
