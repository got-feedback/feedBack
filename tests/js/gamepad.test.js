// Behavioral tests for static/v3/gamepad.js — the controller polling state
// machine. gamepad.js is a plain IIFE with no exports, so it's loaded into a vm
// with a fake navigator/window/document and driven frame-by-frame through a
// manual requestAnimationFrame queue. This exercises the parts that were only
// ever checked on a real Steam Deck: standard-mapping filtering, Steam Input's
// duplicate-slot dedup, disconnect masking, button edge-detection, d-pad/stick
// key-repeat timing, and the analog-stick deadzone.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'static', 'v3', 'gamepad.js'), 'utf8');

function pad(index, opts = {}) {
  return {
    index,
    connected: opts.connected !== false,
    mapping: opts.mapping || 'standard',
    buttons: (opts.buttons || []).map(p => ({ pressed: !!p })),
    axes: opts.axes || [0, 0],
  };
}

// Load a fresh gamepad.js instance with a controllable environment.
function load() {
  let pads = [];
  const listeners = {};
  const rafQueue = [];
  const fired = [];        // synthetic key codes dispatched at the focused element
  const toasts = [];       // {title,...} from fbNotify.show
  let clock = 0;

  const activeElement = { dispatchEvent(evt) { fired.push(evt.code); return true; } };
  const sandbox = {
    console: { log() {}, error() {} },
    performance: { now: () => clock },
    requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
    navigator: { getGamepads: () => pads },
    KeyboardEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    document: {
      activeElement,
      // revealPlayerRail() looks these up; returning null makes button 3 a no-op.
      querySelector: () => null,
    },
    window: {
      addEventListener: (t, fn) => { (listeners[t] || (listeners[t] = [])).push(fn); },
      fbNotify: { show: (o) => toasts.push(o) },
    },
  };
  vm.runInNewContext(SRC, sandbox);

  const emit = (type, gamepad) => (listeners[type] || []).forEach(fn => fn({ gamepad }));
  return {
    setPads: (arr) => { pads = arr; },
    connect: (gp) => emit('gamepadconnected', gp),
    disconnect: (gp) => emit('gamepaddisconnected', gp),
    tick: () => { const fn = rafQueue.shift(); if (fn) fn(); },
    polling: () => rafQueue.length > 0,     // a live tick re-queues itself only while polling
    setClock: (t) => { clock = t; },
    fired, toasts,
  };
}

test('a non-standard pad is ignored entirely (no toast, no polling)', () => {
  const g = load();
  const p = pad(0, { mapping: 'xbox-nonstandard' });
  g.setPads([p]);
  g.connect(p);
  assert.equal(g.toasts.length, 0);
  assert.equal(g.polling(), false);
});

test('a standard pad connecting toasts once and starts polling', () => {
  const g = load();
  const p = pad(0);
  g.setPads([p]);
  g.connect(p);
  assert.equal(g.toasts.length, 1);
  assert.equal(g.toasts[0].title, 'Controller connected');
  assert.equal(g.polling(), true);
});

test("Steam Input's duplicate virtual slots only toast once", () => {
  const g = load();
  const a = pad(0), b = pad(1);
  g.setPads([a, b]);
  g.connect(a);
  g.connect(b);            // same physical controller, second XInput mirror slot
  assert.equal(g.toasts.length, 1, 'one physical controller = one toast');
});

test('face buttons edge-detect: fire once per press, not once per frame', () => {
  const g = load();
  const p = pad(0, { buttons: [true] }); // button 0 held down
  g.setPads([p]);
  g.connect(p);
  g.tick();
  g.tick();                // still held on the next frame
  assert.deepEqual(g.fired, ['Space'], 'held button must not auto-repeat');

  p.buttons[0].pressed = false; g.tick();   // release
  p.buttons[0].pressed = true;  g.tick();    // press again
  assert.deepEqual(g.fired, ['Space', 'Space'], 'a fresh press fires again');
});

test('button 1 maps to Escape; button 3 (rail reveal) fires no key', () => {
  const g = load();
  const p = pad(0, { buttons: [false, true, false, true] });
  g.setPads([p]);
  g.connect(p);
  g.tick();
  assert.deepEqual(g.fired, ['Escape'], 'B=Escape, Y=rail-reveal (no synthetic key)');
});

test('d-pad / stick repeat: initial fire, delay, then interval repeats', () => {
  const g = load();
  const p = pad(0, { buttons: [] }); // no buttons; drive via the d-pad indices
  p.buttons = Array.from({ length: 16 }, () => ({ pressed: false }));
  p.buttons[13].pressed = true;      // ArrowDown
  g.setPads([p]);
  g.connect(p);

  g.setClock(0);   g.tick();   // initial press
  g.setClock(399); g.tick();   // before the 400ms repeat delay
  g.setClock(400); g.tick();   // repeat delay elapsed
  assert.deepEqual(g.fired, ['ArrowDown', 'ArrowDown'], 'one initial + one repeat at 400ms, nothing at 399ms');
});

test('analog stick honors the deadzone', () => {
  const g = load();
  const p = pad(0);
  p.buttons = Array.from({ length: 16 }, () => ({ pressed: false }));
  g.setPads([p]);
  g.connect(p);

  p.axes = [0, 0.4]; g.setClock(0); g.tick();   // below 0.5 deadzone → nothing
  assert.deepEqual(g.fired, [], 'sub-deadzone deflection is ignored');
  p.axes = [0.6, 0]; g.setClock(1); g.tick();    // right, past deadzone
  assert.deepEqual(g.fired, ['ArrowRight']);
});

test('disconnecting one of two live slots does not stop polling or toast', () => {
  const g = load();
  const a = pad(0), b = pad(1);
  g.setPads([a, b]);
  g.connect(a); g.connect(b);
  g.toasts.length = 0;

  b.connected = false;                    // Steam mirror slot drops
  g.setPads([a, b]);
  g.disconnect(b);
  assert.equal(g.toasts.length, 0, 'a still-live standard pad masks the mirror disconnect');
  assert.equal(g.polling(), true);
});

test('disconnecting the last live pad stops polling and toasts', () => {
  const g = load();
  const a = pad(0);
  g.setPads([a]);
  g.connect(a);
  a.connected = false;
  g.setPads([a]);
  g.disconnect(a);
  assert.equal(g.toasts.some(t => t.title === 'Controller disconnected'), true);
  // Drain the final queued tick; polling must not re-queue itself.
  g.tick();
  assert.equal(g.polling(), false);
});

test('polling acts only on the live standard pad, skipping stale/non-standard slots', () => {
  const g = load();
  const dead = pad(0, { connected: false, buttons: [true] });   // frozen, disconnected
  const raw = pad(1, { mapping: 'raw-hid', buttons: [true] });   // non-standard
  const live = pad(2, { buttons: [true] });                      // standard, button 0 down
  g.setPads([dead, raw, live]);
  g.connect(live);
  g.tick();
  assert.deepEqual(g.fired, ['Space'], 'input read from the live standard pad only');
});
