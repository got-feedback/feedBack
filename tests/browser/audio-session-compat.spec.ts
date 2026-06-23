import { test, expect } from '@playwright/test';

test('legacy audio fader and analyser bridges stay visible in browser diagnostics', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.screen.active', { timeout: 10000 });

  const result = await page.evaluate(() => {
    const appWindow = window as any;
    let faderValue = 1;
    appWindow.feedBack.audio.registerFader({
      id: 'browser-smoke',
      label: 'Browser Smoke',
      min: 0,
      max: 1,
      step: 0.1,
      defaultValue: 1,
      getValue: () => faderValue,
      setValue: (value: number) => { faderValue = value; },
    });
    appWindow.feedBack.audioSession.recordBridgeHit({
      domain: 'audio-mix',
      bridgeId: 'audio-mix.analyser',
      legacySurface: 'browser smoke analyser',
      participantId: 'highway_3d',
    });
    const snapshot = appWindow.feedBack.audioSession.snapshot();
    const diagnostics = appWindow.feedBack.capabilities.snapshotDiagnostics();
    return {
      hasFader: snapshot.domains['audio-mix'].participants.some((entry: any) => entry.participantId === 'fader.browser-smoke'),
      hasAnalyserBridge: snapshot.domains['audio-mix'].bridges.some((entry: any) => entry.bridgeId === 'audio-mix.analyser'),
      shimHit: diagnostics.compatibilityShims.some((entry: any) => entry.shimId === 'audio-mix.analyser' && entry.hitCount >= 1),
    };
  });

  expect(result.hasFader).toBe(true);
  expect(result.hasAnalyserBridge).toBe(true);
  expect(result.shimHit).toBe(true);
});