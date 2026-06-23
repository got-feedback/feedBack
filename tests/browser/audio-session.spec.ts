import { test, expect } from '@playwright/test';

test('audio session runtime is available on page load', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.screen.active', { timeout: 10000 });

  const snapshot = await page.evaluate(() => {
    const appWindow = window as any;
    if (!appWindow.feedBack?.audioSession?.snapshot) {
      throw new Error('audioSession host not available');
    }
    return appWindow.feedBack.audioSession.snapshot();
  });

  expect(snapshot.schema).toBe('feedBack.audio_session.diagnostics.v1');
  expect(snapshot.domains['audio-mix']).toBeTruthy();
  expect(snapshot.domains['audio-input']).toBeTruthy();
  expect(snapshot.domains['audio-monitoring']).toBeTruthy();
  expect(snapshot.domains.stems).toBeTruthy();
});