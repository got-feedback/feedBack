// Windowed song lists (feedBack#965).
//
// A song list used to render EVERY song. On a flat 50,944-song library that is
// one div with 50,938 children and ~1.3 MILLION DOM nodes (~25 per row) —
// ~4.2 GB of renderer RSS, for a screen the user may not even be looking at. It
// also poisoned unrelated code: any `document.querySelector` miss anywhere in
// the app had to walk that whole tree.
//
// _visibleWindow is the arithmetic that decides which slice is on screen. If it
// is wrong the list silently shows the wrong songs, or scrolls to the wrong
// place, so it is tested directly — the DOM glue around it is not the risky bit.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
    const window = {
        console,
        document: {
            readyState: 'complete',
            addEventListener() {},
            getElementById() { return null; },
            querySelector() { return null; },
            querySelectorAll() { return []; },
            createElement() { return { style: {}, classList: { add() {}, remove() {}, contains() { return false; } }, addEventListener() {}, appendChild() {} }; },
        },
        addEventListener() {},
        localStorage: { getItem() { return null; }, setItem() {} },
        performance: { now: () => 0 },
        setInterval() { return 0; },
        clearInterval() {},
        requestAnimationFrame() { return 0; },
        cancelAnimationFrame() {},
        getComputedStyle() { return { overflowY: 'visible', paddingTop: '0px', paddingBottom: '0px' }; },
        innerHeight: 800,
    };
    window.window = window;
    window.globalThis = window;
    const ctx = vm.createContext(window);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8'), ctx, { filename: 'screen.js' });
    assert.ok(window.folderLibrary && window.folderLibrary.__test, 'plugin must expose __test');
    return window.folderLibrary.__test;
}

const { visibleWindow, VIRTUAL_BUFFER, VIRTUAL_MIN } = load();

// A flat 50k library in list view: 1 song per row, 44px rows, 800px viewport.
const ROW = 44;
const VH = 800;
const TOTAL = 50938;

test('the whole point: a 50k list renders a bounded window, not 50k rows', () => {
    const w = visibleWindow(0, VH, ROW, 1, TOTAL, TOTAL);
    const rendered = w.end - w.start;
    assert.ok(rendered < 60, `expected a small window, got ${rendered} rows`);
    // ~18 rows fit in 800px, plus buffer above and below.
    assert.ok(rendered >= Math.ceil(VH / ROW), 'must at least fill the viewport');
});

test('at the top: starts at 0, all remaining rows are bottom padding', () => {
    const w = visibleWindow(0, VH, ROW, 1, TOTAL, TOTAL);
    assert.equal(w.start, 0);
    assert.equal(w.padRowsTop, 0);
    assert.equal(w.padRowsBottom, TOTAL - w.end);
});

test('scrolled into the middle: window tracks the scroll, padding adds up', () => {
    const scrolled = 10000 * ROW;                 // row 10,000 at the fold
    const w = visibleWindow(-scrolled, VH, ROW, 1, TOTAL, TOTAL);
    assert.equal(w.start, (10000 - VIRTUAL_BUFFER) * 1);
    assert.ok(w.end > w.start);
    // The invariant that keeps the scrollbar honest: padding rows + rendered
    // rows must account for every song, or the list changes height as you scroll.
    assert.equal(w.padRowsTop + (w.end - w.start) + w.padRowsBottom, TOTAL);
});

test('at the very bottom: no bottom padding, end lands on the last song', () => {
    const rows = TOTAL;
    const scrolled = rows * ROW - VH;             // scrolled to the end
    const w = visibleWindow(-scrolled, VH, ROW, 1, rows, TOTAL);
    assert.equal(w.end, TOTAL);
    assert.equal(w.padRowsBottom, 0);
    assert.equal(w.padRowsTop + (w.end - w.start), TOTAL);
});

test('grid view: perRow songs collapse into one row', () => {
    const perRow = 6;
    const rows = Math.ceil(TOTAL / perRow);
    const w = visibleWindow(0, VH, 190, perRow, rows, TOTAL);
    assert.equal(w.start, 0);
    assert.equal(w.start % perRow, 0, 'a window must start on a row boundary');
    assert.ok(w.end <= TOTAL);
    assert.ok((w.end - w.start) < 200, 'grid window must stay bounded');
});

test('scrolled far past the list: keeps one row, never a negative window', () => {
    const w = visibleWindow(-99999999, VH, ROW, 1, TOTAL, TOTAL);
    assert.ok(w.end > w.start, 'window must never invert');
    assert.ok(w.start >= 0 && w.end <= TOTAL);
    assert.equal(w.padRowsTop + (w.end - w.start) + w.padRowsBottom, TOTAL);
});

test('list not yet scrolled to (below the fold): still yields a valid window', () => {
    const w = visibleWindow(5000, VH, ROW, 1, TOTAL, TOTAL);   // list starts below viewport
    assert.equal(w.start, 0);
    assert.ok(w.end > 0);
});

test('degenerate inputs fall back to rendering everything, never to a broken window', () => {
    // Measured height of 0 (e.g. list still display:none) must not divide by zero
    // and must not silently render an empty list.
    const w = visibleWindow(0, VH, 0, 1, TOTAL, TOTAL);
    assert.equal(w.start, 0);
    assert.equal(w.end, TOTAL);
    assert.equal(w.padRowsTop, 0);
    assert.equal(w.padRowsBottom, 0);
});

test('small lists are below the virtualization threshold', () => {
    assert.ok(VIRTUAL_MIN >= 100, 'threshold must be high enough that normal folders are untouched');
});
