// song_preview integration markup (feedBack — Folders view hover preview).
//
// The Folder Library does NOT implement hover-preview itself. It relies on the
// separate `song_preview` plugin, exactly like the grid and list views. That
// plugin's host adapter finds previewable elements with the selector
// `#v3-songs [data-fn]` and requires each to contain a `[data-v3-play]`
// descendant (the surface it overlays its indicator on), reading the raw
// filename from `data-fn`.
//
// So the ENTIRE contract Folder Library owns is: every song card and row it
// renders must carry `data-fn` (raw filename) and expose a `[data-v3-play]`
// surface. If a refactor drops either, folder cards silently stop previewing
// while grid/list keep working — a regression that's invisible without a live
// song_preview install. These tests pin the markup so that can't happen.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A minimal DOM element mock — just enough for _songCard / _songRow to run.
// No jsdom in this repo (see virtual_list.test.js); the element tracks the few
// things the contract cares about: dataset, attributes, and a child tree that
// querySelector('[data-v3-play]') can walk.
function makeEl(tag) {
    const attrs = {};
    const el = {
        tagName: String(tag || '').toUpperCase(),
        style: {},              // supports .cssText and arbitrary props
        dataset: {},
        className: '',
        children: [],
        parentNode: null,
        addEventListener() {},
        removeEventListener() {},
        setAttribute(k, v) { attrs[k] = String(v); },
        getAttribute(k) { return k in attrs ? attrs[k] : null; },
        hasAttribute(k) { return k in attrs; },
        appendChild(child) { el.children.push(child); if (child) child.parentNode = el; return child; },
        classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
        remove() {},
        // Only the '[data-v3-play]'-style attribute selector is needed.
        querySelector(sel) {
            const attr = sel.replace(/^\[|\]$/g, '');
            const stack = el.children.slice();
            while (stack.length) {
                const n = stack.shift();
                if (n && n.hasAttribute && n.hasAttribute(attr)) return n;
                if (n && n.children) stack.push(...n.children);
            }
            return null;
        },
    };
    return el;
}

function load() {
    const window = {
        console,
        document: {
            readyState: 'complete',
            addEventListener() {},
            getElementById() { return null; },
            querySelector() { return null; },
            querySelectorAll() { return []; },
            createElement(tag) { return makeEl(tag); },
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

const { songCard, songRow } = load();

// A raw filename with a subfolder + spaces — the kind of value song_preview
// URL-encodes downstream, so it must reach data-fn verbatim, not pre-encoded.
const FILENAME = 'Some Artist/A Song.sloppak';
const SONG = { filename: FILENAME, title: 'A Song', artist: 'Some Artist' };

test('song_preview helpers are exposed for the markup contract', () => {
    assert.equal(typeof songCard, 'function');
    assert.equal(typeof songRow, 'function');
});

test('grid card carries data-fn (raw) and a data-v3-play surface', () => {
    const card = songCard(SONG, 'Unsorted');
    assert.equal(card.dataset.fn, FILENAME, 'data-fn must be the raw, un-encoded filename');
    assert.ok(card.querySelector('[data-v3-play]'), 'card must contain a [data-v3-play] surface');
});

test('list row carries data-fn (raw) and a data-v3-play surface', () => {
    const row = songRow(SONG, 'Unsorted');
    assert.equal(row.dataset.fn, FILENAME, 'data-fn must be the raw, un-encoded filename');
    assert.ok(row.querySelector('[data-v3-play]'), 'row must contain a [data-v3-play] surface');
});

test('card renders without depending on any optional song metadata', () => {
    // song_preview only needs filename; the card must build from a bare song
    // (no duration/arrangements/stems/lyrics/tuning/year) without throwing.
    assert.doesNotThrow(() => songCard({ filename: FILENAME }, 'Unsorted'));
    assert.doesNotThrow(() => songRow({ filename: FILENAME }, 'Unsorted'));
});
