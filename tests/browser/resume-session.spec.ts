import { test, expect } from '@playwright/test';

// Resume-last-session: leaving the player snapshots {song, arrangement,
// position, speed} so an exit is recoverable via a non-blocking "Resume" pill.
// These exercise the deterministic plumbing (snapshot guards, staleness, the
// pill, and resume consumption) without depending on real audio timing.

const RESUME_KEY = 'feedBack.resumeSession';

// Make playSong()'s WebSocket a no-network mock that emits a song_info + ready.
async function installMockSong(page) {
  await page.evaluate(() => {
    const messages = [
      { type: 'song_info', title: 'Mock Song', artist: 'Mock Artist', arrangement: 'Lead', arrangement_index: 0, duration: 90, tuning: [0, 0, 0, 0, 0, 0], stringCount: 6, arrangements: [{ index: 0, name: 'Lead', notes: 1 }] },
      { type: 'ready' },
    ];
    class MockWebSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      readyState = MockWebSocket.CONNECTING;
      onopen = null; onmessage = null; onerror = null; onclose = null; url;
      constructor(url) {
        this.url = url;
        setTimeout(() => {
          this.readyState = MockWebSocket.OPEN;
          if (this.onopen) this.onopen(new Event('open'));
          for (const m of messages) if (this.onmessage) this.onmessage({ data: JSON.stringify(m) });
        }, 0);
      }
      send() {}
      close() { this.readyState = MockWebSocket.CLOSED; if (this.onclose) this.onclose(new CloseEvent('close')); }
    }
    // @ts-ignore
    window.WebSocket = MockWebSocket;
  });
}

async function openPlayerWithMockSong(page) {
  await installMockSong(page);
  await page.evaluate(async () => {
    // @ts-ignore
    await window.playSong('mock-song.sloppak');
  });
  await page.waitForSelector('#player.active', { timeout: 5000 });
  await expect(page.locator('#hud-title')).toHaveText('Mock Song', { timeout: 5000 });
}

test.describe('Resume last session', () => {
  test.beforeEach(async ({ page }) => {
    // Suppress the first-run onboarding overlay (a modal that intercepts
    // pointer/keyboard events) so the player isn't covered.
    await page.route('**/api/profile', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: { display_name: 'Test', player_hash: 'test', onboarded: true } });
      } else { await route.continue(); }
    });
    await page.goto('/');
    await page.waitForSelector('.screen.active', { timeout: 10000 });
    await page.evaluate((k) => localStorage.removeItem(k), RESUME_KEY);
  });

  test('snapshots song + arrangement + position once you are mid-song', async ({ page }) => {
    await openPlayerWithMockSong(page);
    const snap = await page.evaluate(() => {
      // @ts-ignore
      window._snapshotResumeSession(30);
      // @ts-ignore
      return window._readResumeSession();
    });
    expect(snap).not.toBeNull();
    expect(snap.f).toBe('mock-song.sloppak');
    expect(snap.a).toBe(0);
    expect(Math.round(snap.t)).toBe(30);
    expect(snap.title).toBe('Mock Song');
  });

  test('does NOT snapshot a barely-started or basically-finished song', async ({ page }) => {
    await openPlayerWithMockSong(page);
    const result = await page.evaluate(() => {
      // @ts-ignore
      window._snapshotResumeSession(1);          // < 3s min → ignored
      // @ts-ignore
      const tooEarly = window._readResumeSession();
      // duration is 90; end-guard is 5s, so 88 > 85 → ignored
      // @ts-ignore
      window._snapshotResumeSession(88);
      // @ts-ignore
      const tooLate = window._readResumeSession();
      return { tooEarly, tooLate };
    });
    expect(result.tooEarly).toBeNull();
    expect(result.tooLate).toBeNull();
  });

  test('a stale (>24h) snapshot is ignored', async ({ page }) => {
    const got = await page.evaluate((k) => {
      const old = { f: 'old.sloppak', a: 0, t: 42, sp: 1, title: 'Old', ts: Date.now() - 25 * 60 * 60 * 1000 };
      localStorage.setItem(k, JSON.stringify(old));
      // @ts-ignore
      return window._readResumeSession();
    }, RESUME_KEY);
    expect(got).toBeNull();
  });

  test('the Resume pill appears off-player and hides on the player', async ({ page }) => {
    await page.evaluate((k) => {
      const snap = { f: 'mock-song.sloppak', a: 0, t: 30, sp: 1, title: 'Mock Song', artist: 'Mock Artist', ts: Date.now() };
      localStorage.setItem(k, JSON.stringify(snap));
      // @ts-ignore
      window.feedBack._maybeShowResumePill();
    }, RESUME_KEY);

    await expect(page.locator('#fb-resume-pill')).toBeVisible();
    await expect(page.locator('#fb-resume-pill')).toContainText('Mock Song');

    // Entering the player hides it (screen:changed → _hideResumePill()).
    await page.evaluate(() => { /* @ts-ignore */ window.showScreen('player'); });
    await page.waitForSelector('#player.active', { timeout: 5000 });
    await expect(page.locator('#fb-resume-pill')).toHaveCount(0);
  });

  test('dismissing the pill removes it and does not re-show it this session', async ({ page }) => {
    await page.evaluate((k) => {
      const snap = { f: 'mock-song.sloppak', a: 0, t: 30, sp: 1, title: 'Mock Song', ts: Date.now() };
      localStorage.setItem(k, JSON.stringify(snap));
      // @ts-ignore
      window.feedBack._maybeShowResumePill();
    }, RESUME_KEY);

    await expect(page.locator('#fb-resume-pill')).toBeVisible();
    await page.locator('#fb-resume-pill button[aria-label="Dismiss"]').click();
    await expect(page.locator('#fb-resume-pill')).toHaveCount(0);

    // A re-offer attempt within the same session is suppressed.
    await page.evaluate(() => { /* @ts-ignore */ window.feedBack._maybeShowResumePill(); });
    await expect(page.locator('#fb-resume-pill')).toHaveCount(0);
  });

  test('resumeLastSession() re-enters the song and consumes the snapshot', async ({ page }) => {
    await installMockSong(page);
    await page.evaluate((k) => {
      const snap = { f: 'mock-song.sloppak', a: 0, t: 30, sp: 1, title: 'Mock Song', ts: Date.now() };
      localStorage.setItem(k, JSON.stringify(snap));
    }, RESUME_KEY);

    await page.evaluate(async () => { /* @ts-ignore */ await window.resumeLastSession(); });

    await page.waitForSelector('#player.active', { timeout: 5000 });
    // The snapshot is consumed (cleared) so it isn't offered again.
    const remaining = await page.evaluate((k) => localStorage.getItem(k), RESUME_KEY);
    expect(remaining).toBeNull();
  });
});
