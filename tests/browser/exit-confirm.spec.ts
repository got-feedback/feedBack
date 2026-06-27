import { test, expect } from '@playwright/test';

// Opt-in "Ask before leaving a song" confirm. Default OFF → Escape/✕ leave
// instantly. When ON, a true-modal confirm appears; Escape is monotonic (the
// second Escape leaves), and Space/Enter activate the default-focused "Leave".

const CONFIRM_KEY = 'confirmExitSong';

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
  await page.evaluate(async () => { /* @ts-ignore */ await window.playSong('mock-song.sloppak'); });
  await page.waitForSelector('#player.active', { timeout: 5000 });
  await expect(page.locator('#hud-title')).toHaveText('Mock Song', { timeout: 5000 });
}

test.describe('Exit-confirm toggle', () => {
  test.beforeEach(async ({ page }) => {
    // Suppress the first-run onboarding overlay (a modal that intercepts
    // pointer/keyboard events) so Escape reaches the player, not the overlay.
    await page.route('**/api/profile', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: { display_name: 'Test', player_hash: 'test', onboarded: true } });
      } else { await route.continue(); }
    });
    await page.goto('/');
    await page.waitForSelector('.screen.active', { timeout: 10000 });
    await page.evaluate((k) => localStorage.removeItem(k), CONFIRM_KEY);
  });

  test('default OFF: Escape exits the song immediately, no confirm', async ({ page }) => {
    await openPlayerWithMockSong(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('#fb-exit-confirm')).toHaveCount(0);
    await expect(page.locator('#player.active')).toHaveCount(0);
  });

  test('ON: Escape opens the confirm and the song stays', async ({ page }) => {
    await page.evaluate(() => { /* @ts-ignore */ window.setConfirmExitSong(true); });
    await openPlayerWithMockSong(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('#fb-exit-confirm')).toBeVisible();
    await expect(page.locator('#player.active')).toHaveCount(1);
    // "Leave" is focused so Space/Enter leaves immediately.
    await expect(page.locator('#fb-exit-confirm button', { hasText: 'Leave' })).toBeFocused();
  });

  test('ON: a second Escape leaves (monotonic)', async ({ page }) => {
    await page.evaluate(() => { /* @ts-ignore */ window.setConfirmExitSong(true); });
    await openPlayerWithMockSong(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('#fb-exit-confirm')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#fb-exit-confirm')).toHaveCount(0);
    await expect(page.locator('#player.active')).toHaveCount(0);
  });

  test('ON: "Stay" keeps you in the song; "Leave" exits', async ({ page }) => {
    await page.evaluate(() => { /* @ts-ignore */ window.setConfirmExitSong(true); });
    await openPlayerWithMockSong(page);

    await page.keyboard.press('Escape');
    await page.locator('#fb-exit-confirm button', { hasText: 'Stay' }).click();
    await expect(page.locator('#fb-exit-confirm')).toHaveCount(0);
    await expect(page.locator('#player.active')).toHaveCount(1);

    await page.keyboard.press('Escape');
    await page.locator('#fb-exit-confirm button', { hasText: 'Leave' }).click();
    await expect(page.locator('#fb-exit-confirm')).toHaveCount(0);
    await expect(page.locator('#player.active')).toHaveCount(0);
  });

  test('ON: Enter on the default-focused "Leave" leaves', async ({ page }) => {
    await page.evaluate(() => { /* @ts-ignore */ window.setConfirmExitSong(true); });
    await openPlayerWithMockSong(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('#fb-exit-confirm')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('#fb-exit-confirm')).toHaveCount(0);
    await expect(page.locator('#player.active')).toHaveCount(0);
  });
});
