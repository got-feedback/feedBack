import { test, expect } from '@playwright/test';

test('app loads', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.screen.active', { timeout: 10000 });
  
  // Check if the page loaded
  const title = await page.title();
  expect(title).toBe('FeedBack');
});

test('check if window has any shortcuts', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.screen.active', { timeout: 10000 });
  
  // Wait a bit for JS to load
  await page.waitForTimeout(2000);
  
  // Check if the keyboard shortcuts system is loaded
  const hasShortcuts = await page.evaluate(() => {
    return typeof window._listShortcuts === 'function';
  });
  
  expect(hasShortcuts).toBe(true);
});
