import { test, expect } from '@playwright/test';

// Issue #686 — a Screen Wake Lock is held only while a song plays so the OS
// screensaver doesn't kick in during windowed-mode playback. We stub
// navigator.wakeLock before app.js runs (headless Chromium rejects a real
// 'screen' request — there is no display) and drive the song:* bus events the
// wake-lock helper listens to. `held` flips true only once a request actually
// resolves and the lock is kept, so the fast play→pause race is observable.
const installWakeLockSpy = () => {
  (window as any).__wakeLockSpy = {
    requestCount: 0,
    releaseCount: 0,
    lastType: null as string | null,
    held: false,
    lastSentinel: null as any,
  };
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: {
      request(type: string) {
        const spy = (window as any).__wakeLockSpy;
        spy.requestCount++;
        spy.lastType = type;
        const listeners: Array<() => void> = [];
        const sentinel = {
          released: false,
          addEventListener(t: string, fn: () => void) {
            if (t === 'release') listeners.push(fn);
          },
          removeEventListener() {},
          release() {
            if (this.released) return Promise.resolve();
            this.released = true;
            spy.releaseCount++;
            spy.held = false;
            listeners.forEach((fn) => fn());
            return Promise.resolve();
          },
        };
        spy.lastSentinel = sentinel;
        // The lock is only "held" once the request resolves and is kept — model
        // that on the microtask so a release that lands first wins the race.
        Promise.resolve().then(() => { if (!sentinel.released) spy.held = true; });
        return Promise.resolve(sentinel);
      },
    },
  });
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installWakeLockSpy);
  await page.goto('/');
  await page.waitForSelector('.screen.active', { timeout: 10000 });
  await page.waitForFunction(() => typeof (window as any).feedBack?.emit === 'function');
});

test('acquires a single screen wake lock on play and releases on pause', async ({ page }) => {
  // The audio 'play' listener emits song:play AND song:resume synchronously;
  // only one 'screen' lock should be requested (the in-flight guard must hold
  // before the first request resolves).
  await page.evaluate(() => {
    (window as any).feedBack.emit('song:play');
    (window as any).feedBack.emit('song:resume');
  });
  await page.waitForFunction(() => (window as any).__wakeLockSpy.held === true);
  expect(await page.evaluate(() => (window as any).__wakeLockSpy.requestCount)).toBe(1);
  expect(await page.evaluate(() => (window as any).__wakeLockSpy.lastType)).toBe('screen');

  await page.evaluate(() => (window as any).feedBack.emit('song:pause'));
  await page.waitForFunction(() => (window as any).__wakeLockSpy.held === false);
});

test('song:ended and song:stop release the wake lock', async ({ page }) => {
  await page.evaluate(() => (window as any).feedBack.emit('song:play'));
  await page.waitForFunction(() => (window as any).__wakeLockSpy.held === true);
  await page.evaluate(() => (window as any).feedBack.emit('song:ended'));
  await page.waitForFunction(() => (window as any).__wakeLockSpy.held === false);

  await page.evaluate(() => (window as any).feedBack.emit('song:play'));
  await page.waitForFunction(() => (window as any).__wakeLockSpy.held === true);
  await page.evaluate(() => (window as any).feedBack.emit('song:stop'));
  await page.waitForFunction(() => (window as any).__wakeLockSpy.held === false);
});

test('fast play→pause before the request resolves leaves no stale lock', async ({ page }) => {
  const before = await page.evaluate(() => (window as any).__wakeLockSpy.requestCount);
  // Pause arrives while navigator.wakeLock.request is still in flight — the
  // resolved sentinel must release itself instead of being held stale.
  await page.evaluate(() => {
    (window as any).feedBack.emit('song:play');
    (window as any).feedBack.emit('song:pause');
  });
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => (window as any).__wakeLockSpy.held)).toBe(false);
  expect(await page.evaluate((n) => (window as any).__wakeLockSpy.requestCount === n + 1, before)).toBe(true);
  expect(await page.evaluate(() => (window as any).__wakeLockSpy.lastSentinel.released)).toBe(true);
});

test('re-acquires the wake lock when the UA releases it while still playing', async ({ page }) => {
  await page.evaluate(() => (window as any).feedBack.emit('song:play'));
  await page.waitForFunction(() => (window as any).__wakeLockSpy.held === true);
  const before = await page.evaluate(() => (window as any).__wakeLockSpy.requestCount);

  // Simulate the UA releasing the lock (power policy / page hide) while
  // playback continues; the release handler re-acquires when still visible.
  await page.evaluate(() => {
    (window as any).feedBack.isPlaying = true;
    (window as any).__wakeLockSpy.lastSentinel.release();
  });
  await page.waitForFunction((n) => (window as any).__wakeLockSpy.requestCount === n + 1 && (window as any).__wakeLockSpy.held === true, before);

  // After a real pause there must be no further re-acquire churn.
  await page.evaluate(() => (window as any).feedBack.emit('song:pause'));
  await page.waitForFunction(() => (window as any).__wakeLockSpy.held === false);
  const settled = await page.evaluate(() => (window as any).__wakeLockSpy.requestCount);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => (window as any).__wakeLockSpy.requestCount)).toBe(settled);
});

test('drives the feedBack-desktop native power bridge, deduped and visibility-gated', async ({ page }) => {
  // In the packaged Electron app navigator.wakeLock is unreliable, so the
  // helper also drives window.feedBackDesktop.power.setScreenAwake — to
  // exactly (wanted && visible), emitting only on change. Inject a spy bridge
  // before app.js runs and assert it tracks playback without duplicate starts.
  await page.addInitScript(() => {
    (window as any).__bridgeCalls = [];
    (window as any).feedBackDesktop = {
      power: { setScreenAwake: (keep: boolean) => (window as any).__bridgeCalls.push(keep) },
    };
  });
  await page.reload();
  await page.waitForSelector('.screen.active', { timeout: 10000 });
  await page.waitForFunction(() => typeof (window as any).feedBack?.emit === 'function');

  // song:play + song:resume fire together but must produce a single `true`.
  await page.evaluate(() => {
    (window as any).feedBack.emit('song:play');
    (window as any).feedBack.emit('song:resume');
  });
  await page.waitForFunction(() => (window as any).__bridgeCalls.filter((x: boolean) => x === true).length === 1);
  await page.evaluate(() => (window as any).feedBack.emit('song:pause'));
  await page.waitForFunction(() => (window as any).__bridgeCalls.filter((x: boolean) => x === false).length === 1);

  // Hidden while playing → bridge OFF (a minimized window mustn't keep the
  // whole display awake); restoring visibility while playing turns it back ON.
  await page.evaluate(() => (window as any).feedBack.emit('song:play'));
  await page.waitForFunction(() => (window as any).__bridgeCalls[(window as any).__bridgeCalls.length - 1] === true);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => (window as any).__bridgeCalls[(window as any).__bridgeCalls.length - 1] === false);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => (window as any).__bridgeCalls[(window as any).__bridgeCalls.length - 1] === true);
});
