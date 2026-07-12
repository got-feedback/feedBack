import { test, expect } from '@playwright/test';

/**
 * The R3c perf gate: highway.js's render loop must not get more expensive.
 *
 * ── WHY FRAME RATE IS THE WRONG THING TO MEASURE ──────────────────────────────
 *
 * The highway AUTO-SCALES. When the smoothed draw cost climbs past its budget
 * (_DRAW_BUDGET_HI_MS = 12ms) it LOWERS THE RENDER RESOLUTION to protect the frame rate
 * (#654). That is exactly right for players. It also means a real performance regression
 * does not show up as dropped frames — it shows up as a BLURRIER PICTURE at a perfectly
 * healthy 60fps.
 *
 * Benchmark fps and you measure the feedback loop, not the renderer, and cheerfully
 * conclude that nothing changed while the picture quietly got worse.
 *
 * So this pins the scale — setRenderScale(1) + setMinRenderScale(1), which clamps
 * autoScale to [1, 1] — and measures `drawMs`, the renderer's own cost, straight from
 * highway.getPerf(). With the adaptive loop held still, drawMs is the signal.
 *
 * ── WHAT IT ASSERTS, AND THE TRAP I FELL INTO FIRST ──────────────────────────
 *
 * My first cut asserted "the auto-scaler was not forced to intervene" — i.e. effectiveScale
 * still == 1. That gate is VACUOUS, and the bite test proved it: I injected a 10x
 * regression (drawMs 2.4 -> 22.4ms, nearly double the 12ms budget) and the test PASSED.
 *
 * Of course it did. setMinRenderScale(1) sets the auto-scaler's FLOOR to 1, so
 * effectiveScale CANNOT drop below 1 — the very pinning that stops the scaler from hiding a
 * regression also stops it from ever reporting one. A guard that cannot fail.
 *
 * So with the scale pinned, drawMs IS the signal, and the threshold is the app's own:
 * _DRAW_BUDGET_HI_MS (12ms) is the cost at which the highway itself decides it is too
 * expensive and starts dropping resolution in production. Exceeding it is not an arbitrary
 * line in a benchmark — it is the renderer failing its own budget.
 *
 * That is a real gate and not a flaky one: the current cost is ~2.4ms, so there is ~5x
 * headroom before it trips, which is far more than headless-CI variance and far less than
 * any regression worth shipping.
 */
test('highway draw cost stays within its own render budget', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.screen.active', { timeout: 10000 });

  const perf = await page.evaluate(async () => {
    const w = window as any;
    const hw = w.highway;
    if (!hw || typeof hw.getPerf !== 'function') {
      return { error: 'highway.getPerf() missing — the perf gate is blind' };
    }

    // Pin the adaptive loop so it cannot mask a regression by dropping resolution.
    hw.setRenderScale(1);
    hw.setMinRenderScale(1);

    // Load a real chart and get the transport ACTUALLY RUNNING.
    //
    // Codex [P2] on the first cut of this, and it was right: headless Chromium may block
    // autoplay, in which case playSong() only LOADS the chart. The audio clock never
    // advances, the draw loop treats the session as paused, and _drawMsEMA keeps whatever
    // stale value it had at startup. The gate would then sample an IDLE renderer and
    // cheerfully report a healthy 2ms — while measuring nothing at all, on exactly the path
    // it exists to protect.
    const d = await (await fetch('/api/library?limit=1')).json();
    const f = d.songs && d.songs[0] && (d.songs[0].filename || d.songs[0].id);
    if (!f) return { error: 'no song in the library — the perf gate has nothing to render' };

    const audio = document.getElementById('audio') as HTMLAudioElement | null;
    if (audio) audio.muted = true;             // so autoplay policy cannot refuse us
    // ENCODE. playSong() decodes its argument before interpolating it into the /ws/highway
    // path, so every real caller hands it encodeURIComponent(filename) (app.js:2879, 4137).
    // A raw filename containing #, ?, % or / builds an invalid WebSocket URL and the song
    // never loads — on which libraries this gate would silently measure an idle renderer
    // rather than fail. Codex [P2], and correct.
    await w.playSong(encodeURIComponent(f));

    // WAIT for playback to start; do NOT force it on a fixed timer.
    //
    // playSong() autoplays, but it takes ~3-4s to get there — it is fetching and decoding
    // stems. An earlier version of this test called togglePlay() after a flat 2s "if not
    // playing yet", which fired BEFORE autoplay, started playback, and then had the app's
    // own autoplay toggle it straight back to PAUSED. The renderer then idled through the
    // whole measurement and the gate happily reported 2ms of nothing.
    const playDeadline = Date.now() + 12000;
    while (!w.feedBack.isPlaying && Date.now() < playDeadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    // Only intervene if it truly never started (a stricter autoplay policy than we expect).
    if (!w.feedBack.isPlaying) await w.togglePlay();

    // Wait for the CHART CLOCK to actually move. That is the proof the render loop is doing
    // real per-frame work, not sitting paused.
    const t0 = hw.getTime();
    const deadline = Date.now() + 8000;
    while (hw.getTime() - t0 < 0.5 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const advanced = hw.getTime() - t0;

    // Let the EMAs settle under load (they are 0.9/0.1, so they need a few dozen frames).
    await new Promise((r) => setTimeout(r, 2500));

    // Sample — and measure the clock ACROSS the sampling window, not just before it.
    // "It advanced at some point earlier" is not good enough: if playback stopped before we
    // started sampling (short song, ended track, autoplay revoked), the EMAs decay toward
    // idle and we would be reading the cost of drawing nothing.
    const sampleStart = hw.getTime();
    const samples: number[] = [];
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      samples.push(hw.getPerf().drawMs);
    }
    const advancedDuringSampling = hw.getTime() - sampleStart;

    return {
      ...hw.getPerf(),
      samples,
      advanced,
      advancedDuringSampling,
      isPlaying: !!w.feedBack.isPlaying,
    };
  });

  expect(perf.error, String(perf.error)).toBeUndefined();

  console.log(
    `[highway perf] drawMs=${(perf.drawMs ?? 0).toFixed(2)}  frameMs=${(perf.frameMs ?? 0).toFixed(2)}  ` +
    `renderScale=${perf.renderScale}  autoScale=${perf.autoScale}  effectiveScale=${perf.effectiveScale}  ` +
    `budget=${perf.drawBudgetLoMs}..${perf.drawBudgetHiMs}ms  ` +
    `playing=${perf.isPlaying}  advancedBefore=${(perf.advanced ?? 0).toFixed(2)}s  ` +
    `advancedDuringSampling=${(perf.advancedDuringSampling ?? 0).toFixed(3)}s`,
  );

  // 0. THE GATE MUST NOT BE MEASURING AN IDLE RENDERER. If the transport never started, the
  //    draw loop is paused, _drawMsEMA is a stale startup value, and every assertion below
  //    passes while testing nothing. Assert the chart clock actually MOVED.
  expect(
    perf.advanced,
    'the chart clock never advanced — playback did not start, so drawMs is a stale idle ' +
    'value and this gate is measuring nothing',
  ).toBeGreaterThan(0.5);

  //    …and it must STILL have been advancing while we sampled. "It moved at some point
  //    earlier" is not good enough: if playback stopped before the sampling window, the EMAs
  //    decay toward idle and we would be measuring the cost of drawing nothing.
  expect(
    perf.advancedDuringSampling,
    'the chart clock was not advancing DURING the sampling window — playback stopped, so ' +
    'these drawMs samples are the cost of an idle renderer, not a rendering one',
  ).toBeGreaterThan(0);

  // 1. the renderer actually ran and reports a sane cost
  expect(Number.isFinite(perf.drawMs)).toBe(true);
  expect(perf.drawMs).toBeGreaterThan(0);

  // 2. THE REGRESSION SIGNAL. With the scale pinned, drawMs is the renderer's true cost.
  //    _DRAW_BUDGET_HI_MS is the app's OWN definition of "too expensive" — the cost at
  //    which it starts sacrificing resolution for players in production. Blow through it
  //    and the renderer has failed its own budget.
  //
  //    Do NOT be tempted to assert on effectiveScale instead: pinning the scale makes that
  //    number a constant, so it can never report anything. See the note above.
  expect(
    perf.drawMs,
    `highway draw cost ${perf.drawMs.toFixed(2)}ms exceeds its own budget of ` +
    `${perf.drawBudgetHiMs}ms — in production this is the point where the highway starts ` +
    `dropping render resolution to keep up`,
  ).toBeLessThan(perf.drawBudgetHiMs);
});
