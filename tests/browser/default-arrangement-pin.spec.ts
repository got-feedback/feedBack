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
