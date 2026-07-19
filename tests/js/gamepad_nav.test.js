// Behavioral tests for static/v3/gamepad-nav.js — the generic Tab-order
// emulation layer. Loaded into a vm with a minimal fake DOM; the module's
// single keydown listener is captured and fed synthetic events. Covers the
// three things it does: arrow-key focus traversal (with clamping), Enter/Space
// activation via .click() (Chromium won't natively activate untrusted keys),
// and the Escape "go back" fallback — plus the !isTrusted / defaultPrevented
// gating that keeps it off real keyboard users.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'static', 'v3', 'gamepad-nav.js'), 'utf8');

function load() {
  const state = { focused: null, clicked: [], screens: [] };
  const body = { tagName: 'BODY' };
  const cfg = { modal: null, nav: null, screen: null, backButtons: [], activeEl: body };
  let handler = null;

  function elem(opts = {}) {
    return {
      tagName: opts.tagName || 'BUTTON',
      type: opts.type,
      isContentEditable: !!opts.isContentEditable,
      offsetParent: opts.visible === false ? null : {},
      _focusables: opts.focusables || [],
      querySelectorAll() { return this._focusables; },
      focus() { state.focused = this; },
      click() { state.clicked.push(this); },
    };
  }

  const document = {
    body,
    get activeElement() { return cfg.activeEl; },
    addEventListener(type, fn) { if (type === 'keydown') handler = fn; },
    querySelector(sel) {
      if (sel.includes('dialog') || sel.includes('modal')) return cfg.modal;
      if (sel.includes('screen.active')) return cfg.screen;
      return null;
    },
    getElementById(id) { return id === 'v3-nav' ? cfg.nav : null; },
    querySelectorAll() { return cfg.backButtons; }, // only the Escape back-button lookup uses this
  };
  const sandbox = { document, window: { showScreen: (id) => state.screens.push(id) } };
  vm.runInNewContext(SRC, sandbox);

  const fire = (over) => handler(Object.assign({ isTrusted: false, defaultPrevented: false, key: '' }, over));
  return { cfg, state, body, elem, fire };
}

// Build a screen holding `n` visible focusables; expose them for cfg.activeEl.
function screenWith(g, n) {
  const items = Array.from({ length: n }, () => g.elem());
  g.cfg.screen = g.elem({ focusables: items });
  g.cfg.nav = g.elem({ focusables: [] });
  return items;
}

test('real keyboard input (isTrusted) is never touched', () => {
  const g = load();
  const items = screenWith(g, 3);
  g.cfg.activeEl = items[0];
  g.fire({ isTrusted: true, key: 'ArrowDown' });
  assert.equal(g.state.focused, null, 'trusted events must pass through untouched');
});

test('a key already handled by another listener (defaultPrevented) is skipped', () => {
  const g = load();
  const items = screenWith(g, 3);
  g.cfg.activeEl = items[0];
  g.fire({ defaultPrevented: true, key: 'ArrowDown' });
  assert.equal(g.state.focused, null);
});

test('ArrowDown/Right moves to the next focusable; ArrowUp/Left to the previous', () => {
  const g = load();
  const items = screenWith(g, 3);
  g.cfg.activeEl = items[1];
  g.fire({ key: 'ArrowDown' });
  assert.equal(g.state.focused, items[2], 'Down = next');

  g.cfg.activeEl = items[1];
  g.fire({ key: 'ArrowLeft' });
  assert.equal(g.state.focused, items[0], 'Left = previous');
});

test('traversal clamps at both ends', () => {
  const g = load();
  const items = screenWith(g, 3);
  g.cfg.activeEl = items[2];
  g.fire({ key: 'ArrowDown' });
  assert.equal(g.state.focused, items[2], 'no wrap past the last item');

  g.cfg.activeEl = items[0];
  g.fire({ key: 'ArrowUp' });
  assert.equal(g.state.focused, items[0], 'no wrap before the first item');
});

test('with nothing relevant focused, the first arrow lands on the first item', () => {
  const g = load();
  const items = screenWith(g, 3);
  g.cfg.activeEl = g.body; // not in the focusable list
  g.fire({ key: 'ArrowRight' });
  assert.equal(g.state.focused, items[0]);
});

test('hidden focusables are skipped (offsetParent visibility)', () => {
  const g = load();
  const visibleA = g.elem();
  const hidden = g.elem({ visible: false });
  const visibleB = g.elem();
  g.cfg.screen = g.elem({ focusables: [visibleA, hidden, visibleB] });
  g.cfg.nav = g.elem({ focusables: [] });
  g.cfg.activeEl = visibleA;
  g.fire({ key: 'ArrowDown' });
  assert.equal(g.state.focused, visibleB, 'the hidden element is not a traversal stop');
});

test('Enter/Space activates the focused control via click()', () => {
  const g = load();
  const btn = g.elem({ tagName: 'BUTTON' });
  g.cfg.activeEl = btn;
  g.fire({ key: 'Enter' });
  g.fire({ key: ' ' });
  assert.deepEqual(g.state.clicked, [btn, btn], 'both Enter and Space activate');
});

test('activation never clicks a focused text field or the body', () => {
  const g = load();
  g.cfg.activeEl = g.elem({ tagName: 'INPUT', type: 'text' });
  g.fire({ key: 'Enter' });
  g.cfg.activeEl = g.body;
  g.fire({ key: ' ' });
  assert.deepEqual(g.state.clicked, [], 'no synthetic click into a text input or the bare body');
});

test('Escape clicks the visible in-screen back button when one exists', () => {
  const g = load();
  const hiddenBack = g.elem({ visible: false }); // a back button from another, now-hidden screen
  const visibleBack = g.elem();
  g.cfg.backButtons = [hiddenBack, visibleBack];
  g.fire({ key: 'Escape' });
  assert.deepEqual(g.state.clicked, [visibleBack], 'the visible back button wins, not DOM order');
  assert.deepEqual(g.state.screens, [], 'no home fallback while a back button handled it');
});

test('Escape with no visible back button falls back to the home screen', () => {
  const g = load();
  g.cfg.backButtons = [g.elem({ visible: false })];
  g.fire({ key: 'Escape' });
  assert.deepEqual(g.state.screens, ['v3-home']);
  assert.deepEqual(g.state.clicked, []);
});
