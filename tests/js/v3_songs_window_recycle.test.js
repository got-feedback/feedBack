'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// Mirror of static/v3/songs.js _cardSig / _buildCardNode / _syncWindow (the
// windowed-grid recycle path, #636 item 3 follow-up) — keep in sync. Exercised
// against a minimal DOM shim so the reconcile invariants are covered off-browser:
//   (1) after every slide the grid's children are exactly [start,end) ascending,
//   (2) card nodes for indices that stay in-window are REUSED (identity kept) —
//       i.e. sliding one row never tears down + rebuilds the whole window (the
//       per-slide stall behind the "skips every so many scrolls" report), and
//   (3) a select-mode toggle rebuilds the visible window (checkbox/ring change).

let NODE_SEQ = 0;
function makeNode() {
    const attrs = {};
    return {
        _uid: ++NODE_SEQ,
        parent: null,
        getAttribute(k) { return k in attrs ? attrs[k] : null; },
        setAttribute(k, v) { attrs[k] = String(v); },
        get nextSibling() {
            const p = this.parent; if (!p) return null;
            const i = p._kids.indexOf(this);
            return i >= 0 && i + 1 < p._kids.length ? p._kids[i + 1] : null;
        },
        remove() {
            const p = this.parent; if (!p) return;
            const i = p._kids.indexOf(this);
            if (i >= 0) p._kids.splice(i, 1);
            this.parent = null;
        },
    };
}
function makeGrid() {
    return {
        _kids: [],
        get children() { return this._kids.slice(); },
        get firstChild() { return this._kids[0] || null; },
        insertBefore(node, ref) {
            if (node.parent) node.remove();
            if (ref == null) this._kids.push(node);
            else { const i = this._kids.indexOf(ref); this._kids.splice(i < 0 ? this._kids.length : i, 0, node); }
            node.parent = this;
            return node;
        },
    };
}

// --- state + the three helpers, mirrored from songs.js ---
const state = { songs: [], selectMode: false };
for (let i = 0; i < 5000; i++) state.songs[i] = { filename: 'song' + i };

function _cardSig(i) { return (state.songs[i] ? 'r' : 's') + (state.selectMode ? '1' : '0'); }
function _buildCardNode(i) {
    const node = makeNode();
    node.setAttribute('data-idx', String(i));
    node.setAttribute('data-sig', _cardSig(i));
    return node;
}
function _syncWindow(grid, start, end) {
    for (const el of Array.from(grid.children)) {
        const a = el.getAttribute('data-idx');
        const idx = a == null ? NaN : Number(a);
        if (!(idx >= start && idx < end) || el.getAttribute('data-sig') !== _cardSig(idx)) el.remove();
    }
    const existing = new Map();
    for (const el of grid.children) existing.set(Number(el.getAttribute('data-idx')), el);
    let ref = grid.firstChild;
    for (let i = start; i < end; i++) {
        let node = existing.get(i);
        if (!node) node = _buildCardNode(i);
        if (node === ref) ref = ref.nextSibling;
        else grid.insertBefore(node, ref);
    }
}

const idxOf = (g) => g._kids.map((n) => Number(n.getAttribute('data-idx')));
const uidOf = (g) => { const m = new Map(); for (const n of g._kids) m.set(Number(n.getAttribute('data-idx')), n._uid); return m; };
function assertContig(g, start, end) {
    const a = idxOf(g);
    assert.strictEqual(a.length, end - start, `len == ${end - start}`);
    for (let k = 0; k < a.length; k++) assert.strictEqual(a[k], start + k, `child ${k} == ${start + k}`);
}

const COLS = 6, WIN = 12 * COLS; // 12 rows visible

test('window stays [start,end) contiguous scrolling down, one row at a time', () => {
    const grid = makeGrid();
    for (let row = 0; row < 40; row++) {
        const start = row * COLS;
        _syncWindow(grid, start, start + WIN);
        assertContig(grid, start, start + WIN);
    }
});

test('in-window card nodes are reused across a slide (no whole-window teardown)', () => {
    const grid = makeGrid();
    _syncWindow(grid, 0, WIN);
    const before = uidOf(grid);
    _syncWindow(grid, COLS, COLS + WIN); // slide down one row
    const after = uidOf(grid);
    let reused = 0, built = 0;
    for (const [i, uid] of after) (before.get(i) === uid ? reused++ : built++);
    assert.strictEqual(built, COLS, `only the entering row is built (${COLS}), got ${built}`);
    assert.strictEqual(reused, WIN - COLS, 'every overlapping card node is reused');
});

test('scrolling back UP reuses nodes too and keeps order', () => {
    const grid = makeGrid();
    for (let row = 0; row < 30; row++) _syncWindow(grid, row * COLS, row * COLS + WIN);
    let prev = uidOf(grid);
    for (let row = 29; row >= 0; row--) {
        const start = row * COLS;
        _syncWindow(grid, start, start + WIN);
        assertContig(grid, start, start + WIN);
        const now = uidOf(grid);
        for (const [i, uid] of prev) if (i >= start && i < start + WIN) assert.strictEqual(now.get(i), uid, `idx ${i} reused going up`);
        prev = now;
    }
});

test('a select-mode toggle rebuilds the visible window', () => {
    const grid = makeGrid();
    const start = 6 * COLS;
    _syncWindow(grid, start, start + WIN);
    const before = uidOf(grid);
    state.selectMode = true;
    _syncWindow(grid, start, start + WIN);
    const after = uidOf(grid);
    let rebuilt = 0;
    for (const [i, uid] of before) if (after.get(i) !== uid) rebuilt++;
    assert.strictEqual(rebuilt, WIN, 'select-mode change rebuilds every visible card');
    assertContig(grid, start, start + WIN);
    state.selectMode = false;
});

test('a large jump (rail seek) rebuilds cleanly with no stale survivors', () => {
    const grid = makeGrid();
    _syncWindow(grid, 0, WIN);
    _syncWindow(grid, 1000 * COLS, 1000 * COLS + WIN); // non-overlapping jump
    assertContig(grid, 1000 * COLS, 1000 * COLS + WIN);
});
