import { test, expect } from '@playwright/test';

async function openPlayerWithMockSong(page) {
  await page.evaluate(() => {
    const messages = [
      { type: 'song_info', title: 'Mock Song', artist: 'Mock Artist', arrangement: 'Lead', arrangement_index: 0, duration: 90, tuning: [0, 0, 0, 0, 0, 0], stringCount: 6, arrangements: [{ index: 0, name: 'Lead', notes: 1 }] },
      { type: 'ready' },
    ];

    class MockWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = MockWebSocket.CONNECTING;
      onopen = null;
      onmessage = null;
      onerror = null;
      onclose = null;
      url;

      constructor(url) {
        this.url = url;
        setTimeout(() => {
          this.readyState = MockWebSocket.OPEN;
          if (this.onopen) this.onopen(new Event('open'));
          for (const message of messages) {
            if (this.onmessage) this.onmessage({ data: JSON.stringify(message) });
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
    // @ts-ignore
    await window.playSong('mock-song.sloppak');
  });
  await page.waitForSelector('#player.active', { timeout: 5000 });
  await expect(page.locator('#hud-title')).toHaveText('Mock Song', { timeout: 5000 });
}

test.describe('Keyboard Shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.screen.active', { timeout: 10000 });
  });

  test.afterEach(async ({ page }) => {
    // Clean up any modals
    await page.evaluate(() => {
      const modal = document.getElementById('shortcuts-modal');
      if (modal) modal.remove();
    });
  });

  test('should have shortcut registry available', async ({ page }) => {
    const hasRegistry = await page.evaluate(() => {
      // @ts-ignore
      return typeof window._listShortcuts === 'function';
    });
    expect(hasRegistry).toBe(true);
  });

  test('should list all registered shortcuts', async ({ page }) => {
    const shortcuts = await page.evaluate(() => {
      // @ts-ignore
      window._listShortcuts();
      // @ts-ignore
      const activePanel = window._panels.get(window.getActiveShortcutPanel());
      if (activePanel) {
        return Array.from(activePanel.shortcuts.values()).map((s: any) => ({
          key: s.key, scope: s.scope
        }));
      }
      return [];
    });
    console.log('Registered shortcuts:', shortcuts);
    // Assert every built-in is present rather than an exact count, so adding a
    // shortcut elsewhere doesn't break this test for the wrong reason.
    const required = [
      { key: '?', scope: 'global' },
      { key: '/', scope: 'library' },
      { key: 'f', scope: 'library' },
      { key: 'e', scope: 'library' },
      { key: 'Space', scope: 'player' },
      { key: 'ArrowLeft', scope: 'player' },
      { key: 'ArrowRight', scope: 'player' },
      { key: 'Escape', scope: 'player' },
      { key: 'Escape', scope: 'settings' },
      { key: '[', scope: 'player' },
      { key: ']', scope: 'player' },
    ];
    for (const r of required) {
      expect(shortcuts).toContainEqual(r);
    }
    expect(shortcuts.filter(s => s.key === '?' && s.scope === 'global')).toHaveLength(1);
  });

  test('should have global ? shortcut for help', async ({ page }) => {
    await page.keyboard.press('?');
    
    const modal = page.locator('#shortcuts-modal');
    await expect(modal).toBeVisible({ timeout: 5000 });
    
    // Title should be "Keyboard shortcuts"
    await expect(modal.locator('h3')).toContainText('Keyboard shortcuts');
  });

  test('should show library shortcuts in help modal', async ({ page }) => {
    await page.keyboard.press('?');
    
    const modal = page.locator('#shortcuts-modal');
    
    // Library shortcuts should be visible on library screen
    await expect(modal).toContainText('Focus search');
    await expect(modal).toContainText('/');

    // Player shortcuts should NOT be visible on library screen
    await expect(modal).not.toContainText('Play/Pause');
  });

  test('should have correct shortcut scopes', async ({ page }) => {
    const shortcuts = await page.evaluate(() => {
      // @ts-ignore
      const shortcuts = [];
      // @ts-ignore
      const activePanel = window._panels.get(window.getActiveShortcutPanel());
      if (activePanel) {
        for (const [, s] of activePanel.shortcuts) {
          shortcuts.push({ key: s.key, scope: s.scope, description: s.description });
        }
      }
      return shortcuts;
    });

    const expectedShortcuts = [
      { key: '?', scope: 'global' },
      { key: '/', scope: 'library' },
      { key: 'f', scope: 'library' },
      { key: 'e', scope: 'library' },
      { key: 'Space', scope: 'player' },
      { key: 'ArrowLeft', scope: 'player' },
      { key: 'ArrowRight', scope: 'player' },
      { key: 'Escape', scope: 'player' },
      { key: 'Escape', scope: 'settings' },
      { key: '[', scope: 'player' },
      { key: ']', scope: 'player' },
    ];

    for (const expected of expectedShortcuts) {
      const found = shortcuts.find(s => s.key === expected.key && s.scope === expected.scope);
      expect(found, `expected shortcut ${expected.scope}::${expected.key}`).toBeDefined();
    }
  });

  test('should trigger ? shortcut on library screen', async ({ page }) => {
    // On library screen
    await page.keyboard.press('?');
    await expect(page.locator('#shortcuts-modal')).toBeVisible();
  });

  test('should focus library search for unshifted / without opening shortcut help', async ({ page }) => {
    await page.keyboard.press('/');

    await expect(page.locator('#lib-filter')).toBeFocused();
    await expect(page.locator('#shortcuts-modal')).toHaveCount(0);
  });

  test('should not open shortcut help for Shift+Slash while typing in search', async ({ page }) => {
    await page.locator('#lib-filter').focus();

    await page.evaluate(() => {
      const input = document.getElementById('lib-filter');
      input?.dispatchEvent(new KeyboardEvent('keydown', {
        key: '/',
        code: 'Slash',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });

    await expect(page.locator('#lib-filter')).toBeFocused();
    await expect(page.locator('#shortcuts-modal')).toHaveCount(0);
  });

  test('Linux Shift+Slash on the library opens help without focusing search behind it (#602)', async ({ page }) => {
    // Linux/Electron reports Shift+/ as key='/', code='Slash'. The help
    // handler must open the modal AND stop the event so the shortcut
    // registry's plain `/` library-search shortcut can't also fire and pull
    // focus to #lib-filter behind the modal (regression for the Copilot
    // review finding on this PR).
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: '/',
        code: 'Slash',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });

    await expect(page.locator('#shortcuts-modal')).toBeVisible();
    await expect(page.locator('#lib-filter')).not.toBeFocused();
  });

  test('should trigger ? shortcut on player screen', async ({ page }) => {
    await openPlayerWithMockSong(page);

    await page.keyboard.press('?');

    await expect(page.locator('#shortcuts-modal')).toBeVisible();
    await expect(page.locator('#shortcuts-modal')).toContainText('Player');
  });

  test('should trigger shortcut help on player screen for Linux Electron Shift+Slash event', async ({ page }) => {
    await openPlayerWithMockSong(page);

    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: '/',
        code: 'Slash',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });

    await expect(page.locator('#shortcuts-modal')).toBeVisible();
    await expect(page.locator('#shortcuts-modal')).toContainText('Player');
  });

  test('should trigger shortcut help on player screen when visualization picker is focused', async ({ page }) => {
    await openPlayerWithMockSong(page);
    await page.locator('#viz-picker').focus();
    await expect(page.locator('#viz-picker')).toBeFocused();

    await page.keyboard.press('?');

    await expect(page.locator('#shortcuts-modal')).toBeVisible();
    await expect(page.locator('#shortcuts-modal')).toContainText('Player');
  });

  test('should trigger ? shortcut on settings screen', async ({ page }) => {
    // Navigate to settings
    await page.click('text=Settings');
    await page.waitForSelector('#settings.active', { timeout: 5000 });
    
    await page.keyboard.press('?');
    await expect(page.locator('#shortcuts-modal')).toBeVisible();
    
    // Should show Settings section with Esc to go back
    await expect(page.locator('#shortcuts-modal')).toContainText('Settings');
    await expect(page.locator('#shortcuts-modal')).toContainText('Go back to previous screen');
    // Should NOT show Library or Global shortcuts
    await expect(page.locator('#shortcuts-modal')).not.toContainText('Focus search');
    await expect(page.locator('#shortcuts-modal')).not.toContainText('Show keyboard shortcuts');
  });

  test('should close modal on Close button', async ({ page }) => {
    await page.keyboard.press('?');
    const modal = page.locator('#shortcuts-modal');
    await expect(modal).toBeVisible();
    
    // Click the close button (SVG icon)
    await page.click('#shortcuts-modal button[data-shortcuts-close]');
    await expect(modal).not.toBeVisible();
  });

  test('should unregister shortcut', async ({ page }) => {
    const result = await page.evaluate(() => {
      // @ts-ignore
      window.registerShortcut({
        key: 'test-key',
        description: 'Test shortcut',
        scope: 'global',
        handler: () => {}
      });
      // @ts-ignore
      const activePanel = window._panels.get(window.getActiveShortcutPanel());
      const beforeUnregister = activePanel ? activePanel.shortcuts.has('global::test-key') : false;
      // @ts-ignore
      const unregistered = window.unregisterShortcut('test-key');
      const afterUnregister = activePanel ? activePanel.shortcuts.has('global::test-key') : false;
      return { beforeUnregister, unregistered, afterUnregister };
    });
    expect(result.beforeUnregister).toBe(true);
    expect(result.unregistered).toBe(true);
    expect(result.afterUnregister).toBe(false);
  });

test('should support condition callbacks', async ({ page }) => {
    const result = await page.evaluate(() => {
      let conditionMet = false;
      // @ts-ignore
      window.registerShortcut({
        key: 'test-cond',
        description: 'Test with condition',
        scope: 'global',
        condition: () => conditionMet,
        // @ts-ignore
        handler: () => { window._conditionHandlerCalled = true; }
      });
      
      // Test with condition false
      // @ts-ignore
      window._conditionHandlerCalled = false;
      const event1 = new KeyboardEvent('keydown', { key: 'test-cond' });
      document.dispatchEvent(event1);
      // @ts-ignore
      const called1 = window._conditionHandlerCalled;
      
      // Test with condition true
      conditionMet = true;
      // @ts-ignore
      window._conditionHandlerCalled = false;
      const event2 = new KeyboardEvent('keydown', { key: 'test-cond' });
      document.dispatchEvent(event2);
      // @ts-ignore
      const called2 = window._conditionHandlerCalled;
      
      // Cleanup
      // @ts-ignore
      window.unregisterShortcut('test-cond');
      
      return { called1, called2 };
    });
    
    expect(result.called1).toBe(false); // Should not fire when condition is false
    expect(result.called2).toBe(true);  // Should fire when condition is true
  });

  test('should support modifier key combinations', async ({ page }) => {
    const result = await page.evaluate(() => {
      let ctrlCalled = false;
      let shiftCalled = false;
      let noModifierCalled = false;
      let sWithoutCtrlCalled = false;
      
      // @ts-ignore
      window.registerShortcut({
        key: 's',
        description: 'Save with Ctrl',
        scope: 'global',
        modifiers: { ctrl: true },
        handler: () => { ctrlCalled = true; }
      });
      
      // @ts-ignore
      window.registerShortcut({
        key: 't',
        description: 'Test with Shift',
        scope: 'global',
        modifiers: { shift: true },
        handler: () => { shiftCalled = true; }
      });
      
      // @ts-ignore
      window.registerShortcut({
        key: 'n',
        description: 'No modifier',
        scope: 'global',
        handler: () => { noModifierCalled = true; }
      });
      
      // Test S without Ctrl first (should not fire)
      const event0 = new KeyboardEvent('keydown', { key: 's' });
      document.dispatchEvent(event0);
      sWithoutCtrlCalled = ctrlCalled;
      
      // Test Ctrl+S
      const event1 = new KeyboardEvent('keydown', { key: 's', ctrlKey: true });
      document.dispatchEvent(event1);
      
      // Test Shift+T
      const event2 = new KeyboardEvent('keydown', { key: 't', shiftKey: true });
      document.dispatchEvent(event2);
      
      // Test N without modifier
      const event3 = new KeyboardEvent('keydown', { key: 'n' });
      document.dispatchEvent(event3);
      
      // Cleanup
      // @ts-ignore
      window.unregisterShortcut('s');
      // @ts-ignore
      window.unregisterShortcut('t');
      // @ts-ignore
      window.unregisterShortcut('n');
      
      return { ctrlCalled, shiftCalled, noModifierCalled, sWithoutCtrlCalled };
    });
    
    expect(result.ctrlCalled).toBe(true);
    expect(result.shiftCalled).toBe(true);
    expect(result.noModifierCalled).toBe(true);
    expect(result.sWithoutCtrlCalled).toBe(false); // Should not fire without Ctrl
  });

  test('should support panel-specific shortcuts', async ({ page }) => {
    const result = await page.evaluate(() => {
      // Create a new panel
      // @ts-ignore
      const panel1 = window.createShortcutPanel('panel-1');
      
      let panelShortcutCalled = false;
      let globalShortcutCalled = false;
      
      // Register a panel-specific shortcut
      // @ts-ignore
      window.setActiveShortcutPanel('panel-1');
      // @ts-ignore
      window.registerShortcut({
        key: 'w',
        description: 'Panel-specific action',
        scope: 'global',
        handler: () => { panelShortcutCalled = true; }
      });
      
      // Register a global shortcut in default panel
      // @ts-ignore
      window.setActiveShortcutPanel('default');
      // @ts-ignore
      window.registerShortcut({
        key: 'g',
        description: 'Global action',
        scope: 'global',
        handler: () => { globalShortcutCalled = true; }
      });
      
      // Test panel-specific shortcut (set panel-1 as active)
      // @ts-ignore
      window.setActiveShortcutPanel('panel-1');
      const event1 = new KeyboardEvent('keydown', { key: 'w' });
      document.dispatchEvent(event1);
      
      // Test global shortcut (set default as active)
      // @ts-ignore
      window.setActiveShortcutPanel('default');
      const event2 = new KeyboardEvent('keydown', { key: 'g' });
      document.dispatchEvent(event2);
      
      // Cleanup
      // @ts-ignore
      panel1.clearShortcuts();
      // @ts-ignore
      window.unregisterShortcut('g');
      // @ts-ignore
      window.setActiveShortcutPanel('default');
      
      return { panelShortcutCalled, globalShortcutCalled };
    });
    
    expect(result.panelShortcutCalled).toBe(true);
    expect(result.globalShortcutCalled).toBe(true);
  });

  test('should show panel-specific shortcuts in modal', async ({ page }) => {
    const result = await page.evaluate(() => {
      // Create a new panel
      // @ts-ignore
      const panel1 = window.createShortcutPanel('panel-1');
      
      // Register a panel-specific shortcut
      // @ts-ignore
      window.setActiveShortcutPanel('panel-1');
      // @ts-ignore
      window.registerShortcut({
        key: 'x',
        description: 'Panel-specific action',
        scope: 'global',
        handler: () => {}
      });
      
      // Register a shortcut in default panel
      // @ts-ignore
      window.setActiveShortcutPanel('default');
      // @ts-ignore
      window.registerShortcut({
        key: 'y',
        description: 'Default panel action',
        scope: 'global',
        handler: () => {}
      });
      
      // Open the modal (default panel is active)
      // @ts-ignore
      window._openShortcutsModal();
      
      // Check if the modal exists and contains the panel-specific shortcut.
      // Use section-targeted DOM queries so an unrelated string elsewhere in
      // the modal can't satisfy these assertions.
      const modal = document.getElementById('shortcuts-modal');
      let hasPanelSection = false;
      let hasShortcut = false;
      let hasKey = false;
      if (modal) {
        const sections = modal.querySelectorAll('section');
        for (const section of sections) {
          const heading = section.querySelector('h4');
          if (heading && heading.textContent.trim() === 'Panel panel-1') {
            hasPanelSection = true;
            hasShortcut = (section.textContent || '').includes('Panel-specific action');
            const kbd = section.querySelector('kbd');
            if (kbd && kbd.textContent.trim() === 'x') {
              hasKey = true;
            }
            break;
          }
        }
      }
      // The "Default panel action" entry should live in a row in the Global
      // section; assert that a row description matches exactly rather than
      // matching anywhere in innerHTML (the modal renders rows as <div>s
      // containing a description <span> and a key <kbd>).
      const hasDefaultShortcut = modal
        ? Array.from(modal.querySelectorAll('section span')).some(
            (s) => (s.textContent || '').trim() === 'Default panel action'
          )
        : false;
      
      // Cleanup
      if (modal) modal.remove();
      // @ts-ignore
      panel1.clearShortcuts();
      // @ts-ignore
      window.unregisterShortcut('y');
      // @ts-ignore
      window.setActiveShortcutPanel('default');
      
      return { hasPanelSection, hasShortcut, hasKey, hasDefaultShortcut };
    });
    
    expect(result.hasPanelSection).toBe(true);  // Should show "Panel panel-1" section
    expect(result.hasShortcut).toBe(true);       // Should show the shortcut description
    expect(result.hasKey).toBe(true);            // Should show the shortcut key
    expect(result.hasDefaultShortcut).toBe(true);  // Should show default panel shortcut
  });

  test('should clear panel shortcuts on cleanup', async ({ page }) => {
    const result = await page.evaluate(() => {
      // Create a new panel
      // @ts-ignore
      const panel1 = window.createShortcutPanel('panel-1');
      
      // Register panel-specific shortcuts
      // @ts-ignore
      window.setActiveShortcutPanel('panel-1');
      // @ts-ignore
      window.registerShortcut({
        key: 'x',
        description: 'Panel shortcut 1',
        scope: 'global',
        handler: () => {}
      });
      // @ts-ignore
      window.registerShortcut({
        key: 'y',
        description: 'Panel shortcut 2',
        scope: 'global',
        handler: () => {}
      });
      
      // Register a global shortcut in default panel (should not be cleared)
      // @ts-ignore
      window.setActiveShortcutPanel('default');
      // @ts-ignore
      window.registerShortcut({
        key: 'z',
        description: 'Global shortcut',
        scope: 'global',
        handler: () => {}
      });
      
      // Clear panel shortcuts
      // @ts-ignore
      panel1.clearShortcuts();
      
      // Check that panel shortcuts are gone
      // @ts-ignore
      const hasX = panel1.shortcuts.has('global::x');
      // @ts-ignore
      const hasY = panel1.shortcuts.has('global::y');
      // @ts-ignore
      const defaultPanel = window._panels.get('default');
      const hasZ = defaultPanel ? defaultPanel.shortcuts.has('global::z') : false;
      
      // Cleanup
      // @ts-ignore
      window.unregisterShortcut('z');
      // @ts-ignore
      window.setActiveShortcutPanel('default');
      
      return { hasX, hasY, hasZ };
    });
    
    expect(result.hasX).toBe(false); // Panel shortcut should be gone
    expect(result.hasY).toBe(false); // Panel shortcut should be gone
    expect(result.hasZ).toBe(true);  // Global shortcut should still exist
  });

  test('should match shortcut by e.code (Space)', async ({ page }) => {
    // The dispatcher matches against both e.key and e.code so that special
    // keys (Space, ArrowLeft, …) registered by their code still fire when the
    // browser delivers e.key=' ' / 'ArrowLeft'. Lock that behaviour in.
    const result = await page.evaluate(() => {
      let calledByCode = false;
      let calledByKey = false;
      // @ts-ignore
      window.registerShortcut({
        key: 'Space',
        description: 'Test e.code match',
        scope: 'global',
        // @ts-ignore
        handler: () => { window._codeHandlerCalled = (window._codeHandlerCalled || 0) + 1; }
      });

      // @ts-ignore
      window._codeHandlerCalled = 0;
      // Real-keyboard event: e.key=' ', e.code='Space'
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }));
      // @ts-ignore
      calledByCode = window._codeHandlerCalled === 1;

      // Synthetic event by e.key='Space' (legacy-style) should also work
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Space' }));
      // @ts-ignore
      calledByKey = window._codeHandlerCalled === 2;

      // Cleanup
      // @ts-ignore
      window.unregisterShortcut('Space');
      return { calledByCode, calledByKey };
    });

    expect(result.calledByCode).toBe(true);
    expect(result.calledByKey).toBe(true);
  });

  test('Space toggles play/pause when a player rail button is focused (#593)', async ({ page }) => {
    await openPlayerWithMockSong(page);

    // Inject a focusable <button> into the player (the bug: BUTTON elements
    // are "interactive controls" so Space was blocked before reaching the
    // shortcut dispatcher) and spy on the player-scope Space shortcut so the
    // assertion does not depend on the real audio path. The dispatcher calls
    // preventDefault() before the handler, so the focused button must NOT
    // also activate.
    await page.evaluate(() => {
      // @ts-ignore
      window.__spacePlayCount = 0;
      // @ts-ignore
      window.__railBtnClicked = 0;
      // @ts-ignore
      window.registerShortcut({
        key: 'Space',
        description: 'Play/Pause (test spy)',
        scope: 'player',
        // @ts-ignore
        handler: () => { window.__spacePlayCount++; },
      });
      const btn = document.createElement('button');
      btn.id = '__test-rail-btn';
      btn.textContent = 'Mixer';
      // @ts-ignore
      btn.addEventListener('click', () => { window.__railBtnClicked++; });
      document.getElementById('player')!.appendChild(btn);
    });

    await page.locator('#__test-rail-btn').focus();
    await expect(page.locator('#__test-rail-btn')).toBeFocused();

    await page.keyboard.press('Space');

    const result = await page.evaluate(() => ({
      // @ts-ignore
      played: window.__spacePlayCount,
      // @ts-ignore
      clicked: window.__railBtnClicked,
    }));
    // Play/pause fired despite the button holding focus…
    expect(result.played).toBe(1);
    // …and the focused button did not also activate (dispatcher preventDefault()).
    expect(result.clicked).toBe(0);
  });

  test('Space in a player-screen text input still types a space, not play/pause (#593)', async ({ page }) => {
    await openPlayerWithMockSong(page);

    // The text-input exemption (_isTextInput) is checked before the player
    // Space carve-out, so typing space in an input must never toggle playback.
    await page.evaluate(() => {
      // @ts-ignore
      window.__spacePlayCount = 0;
      // @ts-ignore
      window.registerShortcut({
        key: 'Space',
        description: 'Play/Pause (test spy)',
        scope: 'player',
        // @ts-ignore
        handler: () => { window.__spacePlayCount++; },
      });
      const input = document.createElement('input');
      input.type = 'text';
      input.id = '__test-player-input';
      document.getElementById('player')!.appendChild(input);
    });

    await page.locator('#__test-player-input').focus();
    await page.keyboard.press('Space');

    const result = await page.evaluate(() => ({
      // @ts-ignore
      played: window.__spacePlayCount,
      value: (document.getElementById('__test-player-input') as HTMLInputElement).value,
    }));
    expect(result.played).toBe(0);
    expect(result.value).toBe(' ');
  });

  test('Space inside a modal dialog over the player reaches the modal, not play/pause (#593)', async ({ page }) => {
    await openPlayerWithMockSong(page);

    // A true modal dialog (role="dialog" aria-modal="true" / .feedBack-modal)
    // layered over the player must trap interaction: Space activates the
    // modal's focused control (native), it does NOT toggle playback behind it.
    await page.evaluate(() => {
      // @ts-ignore
      window.__spacePlayCount = 0;
      // @ts-ignore
      window.__modalBtnClicked = 0;
      // @ts-ignore
      window.registerShortcut({
        key: 'Space',
        description: 'Play/Pause (test spy)',
        scope: 'player',
        // @ts-ignore
        handler: () => { window.__spacePlayCount++; },
      });
      const modal = document.createElement('div');
      modal.id = '__test-modal';
      modal.className = 'feedBack-modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      const btn = document.createElement('button');
      btn.id = '__test-modal-btn';
      btn.textContent = 'Close';
      // @ts-ignore
      btn.addEventListener('click', () => { window.__modalBtnClicked++; });
      modal.appendChild(btn);
      document.body.appendChild(modal);
    });

    await page.locator('#__test-modal-btn').focus();
    await expect(page.locator('#__test-modal-btn')).toBeFocused();

    await page.keyboard.press('Space');

    const result = await page.evaluate(() => ({
      // @ts-ignore
      played: window.__spacePlayCount,
      // @ts-ignore
      clicked: window.__modalBtnClicked,
    }));
    // Playback is NOT toggled behind the modal…
    expect(result.played).toBe(0);
    // …and Space activated the modal's focused button natively.
    expect(result.clicked).toBe(1);
  });

  test('should warn on invalid scope', async ({ page }) => {
    const messages: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'warning') messages.push(msg.text());
    });

    await page.evaluate(() => {
      // @ts-ignore
      window.registerShortcut({
        key: 'test-key',
        description: 'Test shortcut',
        scope: 'invalid-scope',
        handler: () => {}
      });
    });

    expect(messages.some(m => m.includes('invalid scope'))).toBe(true);
  });
});

test.describe('Debug Helpers', () => {
  test('should list shortcuts', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.screen.active');
    
    const result = await page.evaluate(() => {
      // @ts-ignore
      if (typeof window._listShortcuts === 'function') {
        // @ts-ignore
        window._listShortcuts();
        return true;
      }
      return false;
    });
    expect(result).toBe(true);
  });

  test('should test specific shortcut', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.screen.active');
    
    const result = await page.evaluate(() => {
      // @ts-ignore
      if (typeof window._testShortcut === 'function') {
        // @ts-ignore
        window._testShortcut('Space');
        return true;
      }
      return false;
    });
    expect(result).toBe(true);
  });
});
