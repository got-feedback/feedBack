import { test, expect } from '@playwright/test';

test('left-handed setting reaches the 3D Highway renderer with a mocked song stream', async ({ page }) => {
  const errors: string[] = [];

  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', error => {
    errors.push(`PAGE ERROR: ${error.message}`);
  });

  await page.addInitScript(() => {
    localStorage.setItem('lefty', '1');
    localStorage.setItem('vizSelection', 'highway_3d');

    class MockHighwayWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      url: string;
      readyState = MockHighwayWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(url: string) {
        this.url = url;
        setTimeout(() => {
          this.readyState = MockHighwayWebSocket.OPEN;
          this.onopen?.(new Event('open'));
          this.emitSong();
        }, 0);
      }

      send() {}

      close() {
        this.readyState = MockHighwayWebSocket.CLOSED;
        this.onclose?.(new CloseEvent('close'));
      }

      private emit(payload: unknown) {
        this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(payload) }));
      }

      private emitSong() {
        this.emit({
          type: 'song_info',
          artist: 'Smoke Test',
          title: 'Lefty Highway',
          arrangement: 'Lead',
          arrangement_smart_name: 'Lead',
          arrangement_index: 0,
          naming_mode: 'smart',
          tuning: [0, 0, 0, 0, 0, 0],
          stringCount: 6,
          duration: 30,
          audio_url: null,
        });
        this.emit({ type: 'beats', data: [{ time: 0 }, { time: 1 }] });
        this.emit({ type: 'sections', data: [] });
        this.emit({ type: 'anchors', data: [{ time: 0, fret: 1, width: 4 }] });
        this.emit({ type: 'chord_templates', data: [] });
        this.emit({ type: 'notes', data: [{ t: 1, s: 0, f: 3, d: 0 }] });
        this.emit({ type: 'chords', data: [] });
        this.emit({ type: 'handshapes', data: [] });
        this.emit({ type: 'ready' });
      }
    }

    Object.assign(MockHighwayWebSocket, {
      CONNECTING: MockHighwayWebSocket.CONNECTING,
      OPEN: MockHighwayWebSocket.OPEN,
      CLOSING: MockHighwayWebSocket.CLOSING,
      CLOSED: MockHighwayWebSocket.CLOSED,
    });

    window.WebSocket = MockHighwayWebSocket as unknown as typeof WebSocket;
  });

  await page.goto('/');
  await page.waitForSelector('.screen.active', { timeout: 10000 });
  await page.waitForFunction(() => typeof (window as any).playSong === 'function' && !!(window as any).highway);
  await page.waitForFunction(() => {
    const picker = document.getElementById('viz-picker') as HTMLSelectElement | null;
    return picker?.value === 'highway_3d';
  });
  await expect(page.locator('#viz-picker')).toHaveValue('highway_3d');
  await page.evaluate(() => {
    (window as any).__h3dReadySeen = false;
    (window as any).feedBack.on('viz:renderer:ready', () => {
      (window as any).__h3dReadySeen = true;
    }, { once: true });
  });

  await page.evaluate(() => (window as any).playSong('mock-lefty.sloppak', 0));
  await page.waitForSelector('#player.active', { timeout: 10000 });
  await page.waitForFunction(() => (window as any).highway?.getSongInfo?.().title === 'Lefty Highway');
  await page.waitForFunction(() => (window as any).__h3dReadySeen === true, { timeout: 10000 });
  await expect.poll(
    async () => page.evaluate(() => !(window as any).highway.isDefaultRenderer()),
    { timeout: 5000 },
  ).toBe(true);

  await expect.poll(
    async () => page.evaluate(() => (window as any).highway.getLefty()),
    { timeout: 5000 },
  ).toBe(true);

  await page.evaluate(() => (window as any).showScreen('settings'));
  await page.waitForSelector('#settings.active', { timeout: 5000 });
  await expect(page.locator('#setting-lefty')).toBeChecked();

  const allowedErrors = ['favicon.ico'];
  expect(errors.filter(e => !allowedErrors.some(allowed => e.includes(allowed)))).toEqual([]);
});
