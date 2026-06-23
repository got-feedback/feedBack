import { test, expect } from '@playwright/test';

// Progression (spec 010) smoke: nav entries render, the Progress screen shows
// a fresh rank-0 state, the `progression` capability domain has its core
// owner, and equipping a theme toggles the html[data-fb-theme] gate.

// A fresh profile shows the blocking onboarding overlay; onboard via the API
// so nav clicks aren't intercepted (idempotent on an already-onboarded db).
// The 3-step flow requires: (1) profile, (2) path selection, (3) skip calibration.
test.beforeEach(async ({ request }) => {
  await request.post('/api/profile', { data: { display_name: 'Smoke Tester' } });
  await request.post('/api/progression/paths', { data: { add: ['guitar'] } });
  await request.post('/api/progression/onboarding', { data: { action: 'skip' } });
});

test('progress + shop nav entries render and route', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.screen.active', { timeout: 10000 });

  const progressNav = page.locator('[data-v3-nav="progress"]');
  const shopNav = page.locator('[data-v3-nav="shop"]');
  await expect(progressNav).toBeVisible();
  await expect(shopNav).toBeVisible();

  await progressNav.click();
  await expect(page.locator('#v3-progress')).toHaveClass(/active/);
  // Fresh install: Mastery Rank hero renders (rank value present).
  await expect(page.locator('#v3-progress')).toContainText('Mastery Rank');
  await expect(page.locator('#v3-progress')).toContainText('Decibels');

  await shopNav.click();
  await expect(page.locator('#v3-shop')).toHaveClass(/active/);
  await expect(page.locator('#v3-shop')).toContainText('Your Decibels');
});

test('progression capability domain is owned by core', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.screen.active', { timeout: 10000 });

  const result = await page.evaluate(async () => {
    const appWindow = window as any;
    const inspectCmd = await appWindow.feedBack.capabilities.command('progression', 'inspect', {
      requester: 'browser-smoke',
    });
    const pipeline = appWindow.feedBack.capabilities.inspect('progression');
    const owner = (pipeline.participants || []).find((p: any) => p.pluginId === 'core.progression');
    return {
      outcome: inspectCmd.outcome,
      masteryRank: inspectCmd.payload ? inspectCmd.payload.mastery_rank : null,
      ownerRoles: owner ? owner.roles : [],
      // buy-item without user-action authorization must be denied.
      deniedBuy: (await appWindow.feedBack.capabilities.command('progression', 'buy-item', {
        requester: 'browser-smoke',
        payload: { item_id: 'theme.sunset-strat' },
      })).outcome,
    };
  });

  expect(result.outcome).toBe('handled');
  expect(typeof result.masteryRank).toBe('number');
  expect(result.ownerRoles).toContain('owner');
  expect(result.deniedBuy).toBe('denied');
});

test('theme apply toggles the data-fb-theme gate', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.screen.active', { timeout: 10000 });

  const states = await page.evaluate(() => {
    const appWindow = window as any;
    const before = document.documentElement.hasAttribute('data-fb-theme');
    appWindow.v3Theme.apply({ colors: { bg: '#101010', card: '#202020', text: '#ffffff' } });
    const applied = document.documentElement.hasAttribute('data-fb-theme');
    appWindow.v3Theme.apply(null);
    const cleared = document.documentElement.hasAttribute('data-fb-theme');
    return { before, applied, cleared };
  });

  expect(states.before).toBe(false);
  expect(states.applied).toBe(true);
  expect(states.cleared).toBe(false);
});
