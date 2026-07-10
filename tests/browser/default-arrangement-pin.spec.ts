import { test, expect } from '@playwright/test';

interface SettingsPayload {
  dlc_dir: string;
  default_arrangement: string;
  demucs_server_url: string;
  master_difficulty: number;
  av_offset_ms: number;
}

interface SettingsPostPayload {
  default_arrangement?: string;
  [key: string]: unknown;
}

const settingsPayload: SettingsPayload = {
  dlc_dir: '',
  default_arrangement: 'Rhythm',
  demucs_server_url: '',
  master_difficulty: 100,
  av_offset_ms: 0,
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: settingsPayload });
      return;
    }
    await route.continue();
  });
});

test('settings labels auto arrangement as most notes', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('#default-arrangement', { state: 'attached' });

  const labels = await page.locator('#default-arrangement option').allTextContents();

  expect(labels).toContain('Most notes (auto)');
  expect(labels).not.toContain('Auto (most notes)');
});

test('player arrangement pin saves the selected arrangement name', async ({ page }) => {
  const settingsPosts: SettingsPostPayload[] = [];
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: settingsPayload });
      return;
    }
    settingsPosts.push(route.request().postDataJSON());
    await route.fulfill({ json: { message: 'Settings saved' } });
  });

  await page.goto('/');
  await page.waitForSelector('#arr-select', { state: 'attached' });

  await page.evaluate(() => {
    // @ts-ignore - browser app helper
    window.showScreen('player');
    const arrangements = [
      { index: 0, name: 'Lead', notes: 420 },
      { index: 1, name: 'Rhythm', notes: 553 },
      { index: 2, name: 'Bass', notes: 386 },
    ];
    const select = document.getElementById('arr-select') as HTMLSelectElement;
    select.innerHTML = arrangements
      .map(a => `<option value="${a.index}">${a.name} (${a.notes})</option>`)
      .join('');
    select.value = '2';
    // @ts-ignore - browser app namespace
    window.feedBack.currentSong = {
      filename: 'demo.archive',
      arrangement: 'Rhythm',
      arrangementIndex: 2,
      arrangements,
    };
    // @ts-ignore - browser app namespace
    window.feedBack.emit('song:loaded', window.feedBack.currentSong);
  });

  const pin = page.locator('#arr-default-pin');
  await expect(pin).toBeVisible();
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await expect(pin).toHaveAttribute('aria-label', 'Make Bass the default for new songs');
  await expect(pin).toHaveAttribute('title', 'Make Bass the default for new songs');
  await expect.poll(async () => (
    await page.locator('#arr-default-pin').evaluate(el => el.previousElementSibling?.id)
  )).toBe('arr-select');

  await pin.click();

  await expect.poll(() => settingsPosts.length).toBe(1);
  expect(settingsPosts[0]).toEqual({ default_arrangement: 'Bass' });
  await expect(pin).toHaveAttribute('aria-pressed', 'true');
  await expect(pin).toHaveAttribute('aria-label', 'Bass is the default arrangement');
  await expect(pin).toHaveAttribute('title', 'Bass is the default arrangement');
  await expect(page.locator('#default-arrangement')).toHaveValue('Bass');

  await pin.click();
  const unexpectedPost = page
    .waitForRequest(
      req => req.url().includes('/api/settings') && req.method() === 'POST',
      { timeout: 300 }
    )
    .then(() => true)
    .catch(() => false);
  expect(await unexpectedPost).toBe(false);
  expect(settingsPosts).toHaveLength(1);
});

test('player arrangement pin preserves non-built-in arrangement names', async ({ page }) => {
  const settingsPosts: SettingsPostPayload[] = [];
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: settingsPayload });
      return;
    }
    settingsPosts.push(route.request().postDataJSON());
    await route.fulfill({ json: { message: 'Settings saved' } });
  });

  await page.goto('/');
  await page.waitForSelector('#arr-select', { state: 'attached' });

  await page.evaluate(() => {
    // @ts-ignore - browser app helper
    window.showScreen('player');
    const arrangements = [
      { index: 0, name: 'Lead', notes: 420 },
      { index: 1, name: 'Rhythm', notes: 553 },
      { index: 2, name: 'Combo', notes: 610 },
    ];
    const select = document.getElementById('arr-select') as HTMLSelectElement;
    select.innerHTML = arrangements
      .map(a => `<option value="${a.index}">${a.name} (${a.notes})</option>`)
      .join('');
    select.value = '2';
    // @ts-ignore - browser app namespace
    window.feedBack.currentSong = {
      filename: 'demo.archive',
      arrangement: 'Rhythm',
      arrangementIndex: 2,
      arrangements,
    };
    // @ts-ignore - browser app namespace
    window.feedBack.emit('song:loaded', window.feedBack.currentSong);
  });

  await page.locator('#arr-default-pin').click();

  await expect.poll(() => settingsPosts.length).toBe(1);
  expect(settingsPosts[0]).toEqual({ default_arrangement: 'Combo' });
  await expect(page.locator('#default-arrangement')).toHaveValue('Combo');
  await expect(page.locator('#default-arrangement option[value="Combo"]')).toHaveText('Combo (saved default)');

  await page.evaluate(() => {
    // @ts-ignore - browser app helper
    window.saveSettings();
  });

  await expect.poll(() => settingsPosts.length).toBe(2);
  expect(settingsPosts[1]).toMatchObject({ default_arrangement: 'Combo' });
});

test('manually switching arrangement mid-song auto-persists it as the default (feedBack resetbug)', async ({ page }) => {
  // Regression test: switching the #arr-select dropdown while a song is
  // playing used to be scoped to that song only — the next song fell back
  // to the "most notes" heuristic instead of remembering the user's pick.
  // changeArrangement() now calls pinCurrentArrangementDefault() itself, so
  // a plain dropdown switch persists default_arrangement exactly like an
  // explicit ☆ click does.
  const settingsPosts: SettingsPostPayload[] = [];
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: settingsPayload });
      return;
    }
    settingsPosts.push(route.request().postDataJSON());
    await route.fulfill({ json: { message: 'Settings saved' } });
  });

  await page.goto('/');
  await page.waitForSelector('#arr-select', { state: 'attached' });

  // Mock WebSocket so playSong()/changeArrangement()'s WS reconnect never
  // hits the network — same pattern as tests/browser/resume-session.spec.ts.
  // Must run AFTER goto(): navigation replaces the page's window, so
  // installing the mock beforehand would be wiped out.
  await page.evaluate(() => {
    const arrangements = [
      { index: 0, name: 'Lead', notes: 420 },
      { index: 1, name: 'Rhythm', notes: 553 },
      { index: 2, name: 'Bass', notes: 386 },
    ];
    class MockWebSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((ev: Event) => void) | null = null;
      onmessage: ((ev: { data: string }) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;
      url: string;
      constructor(url: string) {
        this.url = url;
        // Honor the explicit ?arrangement= param on reconnect, mirroring
        // the real server's "explicit request wins" resolution — otherwise
        // a changeArrangement()-triggered reconnect would silently snap
        // back to index 0 and make this mock lie about which arrangement
        // is actually active.
        const requested = Number(new URL(url, 'http://x').searchParams.get('arrangement'));
        const active = arrangements.find(a => a.index === requested) || arrangements[0];
        const songInfo = {
          type: 'song_info', title: 'Mock Song', artist: 'Mock Artist',
          arrangement: active.name, arrangement_index: active.index, duration: 90,
          tuning: [0, 0, 0, 0, 0, 0], stringCount: 6, arrangements,
        };
        setTimeout(() => {
          this.readyState = MockWebSocket.OPEN;
          if (this.onopen) this.onopen(new Event('open'));
          for (const m of [songInfo, { type: 'ready' }]) {
            if (this.onmessage) this.onmessage({ data: JSON.stringify(m) });
          }
        }, 0);
      }
      send() {}
      close() {
        this.readyState = MockWebSocket.CLOSED;
        if (this.onclose) this.onclose(new CloseEvent('close'));
      }
    }
    // @ts-ignore
    window.WebSocket = MockWebSocket;
  });

  await page.evaluate(async () => {
    // @ts-ignore - browser app helper
    await window.playSong('mock-song.sloppak');
  });
  await page.waitForSelector('#player.active', { timeout: 5000 });
  await expect(page.locator('#arr-select option')).toHaveCount(3);

  // A plain dropdown switch — no pin click. The v3 UI tucks #arr-select
  // inside a rail popover that's hidden until the user opens it, so drive
  // the native select+change sequence directly rather than via
  // page.selectOption (which requires visibility).
  await page.evaluate((idx) => {
    const sel = document.getElementById('arr-select') as HTMLSelectElement;
    sel.value = idx;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, '2');

  await expect.poll(() => settingsPosts.length).toBe(1);
  expect(settingsPosts[0]).toEqual({ default_arrangement: 'Bass' });
  await expect(page.locator('#arr-default-pin')).toHaveAttribute('aria-pressed', 'true');
});

test('failed settings save does not mark arrangement default as persisted', async ({ page }) => {
  const settingsPosts: SettingsPostPayload[] = [];
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: settingsPayload });
      return;
    }
    settingsPosts.push(route.request().postDataJSON());
    await route.fulfill({ status: 500, json: { error: 'settings write failed' } });
  });

  await page.goto('/');
  await page.waitForSelector('#arr-select', { state: 'attached' });

  await page.evaluate(() => {
    // @ts-ignore - browser app helper
    window.showScreen('player');
    const arrangements = [
      { index: 0, name: 'Lead', notes: 420 },
      { index: 1, name: 'Rhythm', notes: 553 },
      { index: 2, name: 'Bass', notes: 386 },
    ];
    const select = document.getElementById('arr-select') as HTMLSelectElement;
    select.innerHTML = arrangements
      .map(a => `<option value="${a.index}">${a.name} (${a.notes})</option>`)
      .join('');
    select.value = '2';
    // @ts-ignore - browser app namespace
    window.feedBack.currentSong = {
      filename: 'demo.archive',
      arrangement: 'Rhythm',
      arrangementIndex: 2,
      arrangements,
    };
    // @ts-ignore - browser app namespace
    window.feedBack.emit('song:loaded', window.feedBack.currentSong);
  });

  const pin = page.locator('#arr-default-pin');
  await expect(pin).toHaveAttribute('aria-pressed', 'false');

  await page.evaluate(() => {
    // @ts-ignore - browser app helper
    document.getElementById('default-arrangement').value = 'Bass';
    // @ts-ignore - browser app helper
    window.saveSettings();
  });

  await expect.poll(() => settingsPosts.length).toBe(1);
  expect(settingsPosts[0]).toMatchObject({ default_arrangement: 'Bass' });
  await expect(page.locator('#settings-status')).toHaveText('settings write failed');
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await expect(pin).toHaveAttribute('aria-label', 'Make Bass the default for new songs');
  await expect(pin).toHaveAttribute('title', 'Make Bass the default for new songs');
});
