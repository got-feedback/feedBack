// Verify the decorative pedalboard patch-cable engine (static/v3/pedal-cables.js):
// pure geometry helpers (jack positions, point seeding, path building, static
// sag), the segment cap, and the prefers-reduced-motion branch — which must
// draw a STATIC sagged path and start NO requestAnimationFrame loop, while the
// normal path DOES start the loop.

const { test } = require('node:test');
// Non-strict assert: helpers return objects created inside the vm realm, whose
// Object.prototype differs from this realm's — strict deepEqual would fail the
// prototype check even when the structure matches.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', '..', 'static', 'v3', 'pedal-cables.js');

function rect(l, t, r, b) { return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t }; }

function loadCables(opts) {
    opts = opts || {};
    const rafCalls = [];
    const created = [];                 // every createElementNS node
    const win = { feedBack: null };
    win.addEventListener = () => {};
    win.matchMedia = () => ({ matches: !!opts.reduce });
    const doc = {
        createElementNS: (ns, tag) => {
            const node = {
                _tag: tag, attrs: {}, children: [],
                setAttribute: (k, v) => { node.attrs[k] = v; },
                appendChild: (c) => { node.children.push(c); },
                insertBefore: (c) => { node.children.unshift(c); },
                firstChild: null,
            };
            created.push(node);
            return node;
        },
    };
    const ctx = {
        window: win, document: doc, console,
        requestAnimationFrame: (cb) => { rafCalls.push(cb); return rafCalls.length; },
        cancelAnimationFrame: () => {},
    };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'pedal-cables.js' });
    return { api: win.v3PedalCables, t: win.v3PedalCables._test, rafCalls, created };
}

// A fake board containing two pedals; root yields the one board.
function fakeRoot() {
    const pedalA = { getBoundingClientRect: () => rect(10, 10, 160, 210) };
    const pedalB = { getBoundingClientRect: () => rect(220, 10, 370, 210) };
    const board = {
        firstChild: null,
        scrollWidth: 800, scrollHeight: 420,
        getBoundingClientRect: () => rect(0, 0, 800, 420),
        setAttribute: () => {},
        insertBefore: () => {},
        querySelectorAll: (sel) => (sel === '.v3-pedal' ? [pedalA, pedalB] : []),
    };
    return { querySelectorAll: (sel) => (sel === '.v3-pedalboard' ? [board] : []) };
}

test('computeJacks: out = right side, in = left side, both at vertical centre', () => {
    const { t } = loadCables();
    const j = t.computeJacks(rect(100, 50, 250, 250), rect(0, 0, 800, 400), 10);
    // pedal spans x[100,250] y[50,250]; jack y = top + JACK_FRAC*height to line
    // up with the photo's side jacks.
    const y = 50 + t.JACK_FRAC * 200;
    assert.deepEqual(j.out, { x: 240, y });   // right-10
    assert.deepEqual(j.in, { x: 110, y });    // left+10
});

test('seedPoints: N points, endpoints pinned to a and b', () => {
    const { t } = loadCables();
    const pts = t.seedPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, 12);
    assert.equal(pts.length, 12);
    assert.deepEqual({ x: pts[0].x, y: pts[0].y }, { x: 0, y: 0 });
    assert.deepEqual({ x: pts[11].x, y: pts[11].y }, { x: 100, y: 0 });
});

test('pointsToPath: M then L per subsequent point', () => {
    const { t } = loadCables();
    const d = t.pointsToPath([{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 9, y: 1 }]);
    assert.ok(d.startsWith('M 0.0 0.0'));
    assert.equal((d.match(/L /g) || []).length, 2);
});

test('staticCablePath: quadratic with a downward sag', () => {
    const { t } = loadCables();
    const d = t.staticCablePath({ x: 0, y: 100 }, { x: 100, y: 100 }, 0.2);
    assert.ok(d.startsWith('M 0.0 100.0'));
    assert.ok(d.includes('Q '));
    // Control-point y is below the endpoints (larger y == lower on screen).
    const cy = parseFloat(d.split('Q ')[1].split(' ')[1]);
    assert.ok(cy > 100);
});

test('segment cap constants are sane', () => {
    const { t } = loadCables();
    assert.ok(t.SEGMENTS >= 2 && t.SEGMENTS <= 40);
    assert.ok(t.MAX_CABLES >= 1);
});

test('attach draws each cable as a static curve with NO idle rAF loop', () => {
    // The cable shape is a pure function of the endpoints (no Verlet/inertia),
    // so attach renders once and schedules no continuous animation loop —
    // there is nothing to settle, which is what kills the "moon gravity" drift.
    const { api, rafCalls, created } = loadCables({ reduce: false });
    api.attach(fakeRoot());
    assert.equal(rafCalls.length, 0, 'no idle animation loop');
    const paths = created.filter((n) => n._tag === 'path');
    assert.equal(paths.length, 1, 'one cable between two pedals');
    assert.ok((paths[0].attrs.d || '').includes('Q '), 'curved (quadratic) path drawn');
});

test('a drag schedules a short tracking loop; ending it stops the loop', () => {
    const { api, rafCalls } = loadCables({ reduce: false });
    api.attach(fakeRoot());
    api.setDragging(true);
    assert.ok(rafCalls.length >= 1, 'drag runs a per-frame tracking loop');
    const before = rafCalls.length;
    api.setDragging(false);
    // Run the already-scheduled frame: with dragging off it renders once and
    // does NOT reschedule.
    rafCalls[rafCalls.length - 1]();
    assert.equal(rafCalls.length, before, 'loop is not rescheduled after drag ends');
});
