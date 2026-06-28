// Regression guards for two Edit-Metadata modal fixes (static/app.js):
//
//  1. Year is editable — the modal renders an `edit-year` field and
//     saveEditModal() includes `year` in the POST /api/song/<f>/meta body.
//     (Backend already accepts/normalizes year; only the UI omitted it.)
//
//  2. A click-drag that starts inside a field and is released on the backdrop
//     must NOT dismiss the modal. _editModalShouldClose() gates backdrop
//     dismissal on the mousedown having started on the backdrop too.
//
// Functions are extracted from the real shipped source and run in a vm — no
// mirror copies.

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { extractFunction } = require('./test_utils');

const APP_JS = path.join(__dirname, '..', '..', 'static', 'app.js');
const readApp = () => fs.readFileSync(APP_JS, 'utf8');

function loadFn(signature, sandbox, exportAs) {
    const fnSrc = extractFunction(readApp(), signature);
    const ctx = vm.createContext(sandbox);
    vm.runInContext(`${fnSrc}\nglobalThis.${exportAs} = ${exportAs};`, ctx);
    return sandbox[exportAs];
}

// ── Issue: Edit Metadata does not allow changing Year ────────────────────────

test('openEditModal renders a Year field bound to songData.y', () => {
    const src = extractFunction(readApp(), 'function openEditModal');
    assert.match(src, /id="edit-year"/, 'modal must render an #edit-year input');
    assert.match(src, /_escAttr\(songData\.y\)/, 'year input must be populated from songData.y');
});

test('Save button wires via data-edit-save, not an inline onclick that embeds the filename', () => {
    // encodeURIComponent does NOT escape `'`, so embedding the filename in a
    // single-quoted inline `saveEditModal('…')` handler breaks the save for a
    // song whose filename contains an apostrophe (e.g. `Bob's Song.sloppak`).
    // The Save button must use the data-attr + JS-listener pattern instead.
    const src = extractFunction(readApp(), 'function openEditModal');
    assert.doesNotMatch(src, /onclick="saveEditModal\('/, 'Save must not embed the filename in an inline onclick');
    assert.match(src, /data-edit-save/, 'Save button must carry the data-edit-save hook');
    assert.match(src, /querySelector\('\[data-edit-save\]'\)/, 'Save must be wired via addEventListener');
});

test('saveEditModal includes year in the metadata POST body', async () => {
    const calls = [];
    const values = {
        'edit-title': 'My Title', 'edit-artist': 'My Artist',
        'edit-album': 'My Album', 'edit-year': '1998',
        'edit-art-file': null,    // signals the file branch via .files below
        'edit-modal': null,
    };
    const sandbox = {
        decodeURIComponent, encodeURIComponent, JSON, Promise,
        _lastLibSelected: null,
        loadLibrary: () => {}, loadFavorites: () => {},
        fetch: (url, opts) => { calls.push({ url, opts }); return Promise.resolve({ ok: true }); },
        document: {
            getElementById: (id) => {
                if (id === 'edit-art-file') return { files: null };
                if (id === 'edit-modal') return null;
                return id in values ? { value: values[id] } : null;
            },
            querySelector: () => null,            // no active screen
            body: { contains: () => false },
        },
    };
    const saveEditModal = loadFn('async function saveEditModal', sandbox, 'saveEditModal');

    await saveEditModal(encodeURIComponent('Song With Spaces.sloppak'));

    const metaCall = calls.find((c) => /\/api\/song\/.+\/meta$/.test(c.url));
    assert.ok(metaCall, 'expected a POST to /api/song/<filename>/meta');
    const body = JSON.parse(metaCall.opts.body);
    assert.equal(body.year, '1998', 'meta POST body must carry the edited year');
    assert.deepEqual(
        body,
        { title: 'My Title', artist: 'My Artist', album: 'My Album', year: '1998' },
        'meta POST body shape',
    );
});

// ── Issue: Renaming Metadata Closes Modal (click-drag release on backdrop) ────

test('_editModalShouldClose: backdrop needs mousedown to have started there', () => {
    const fn = loadFn('function _editModalShouldClose', {}, '_editModalShouldClose');

    const modalEl = { closest: () => null };                 // the backdrop element
    const innerEl = { closest: () => null };                 // a field inside the modal
    const cancelBtn = { closest: (s) => (s === '[data-edit-close]' ? { tag: 'button' } : null) };

    // Cancel / ✕ always closes, regardless of where the mousedown began.
    assert.equal(fn(cancelBtn, modalEl, false), true, 'Cancel/✕ closes');
    assert.equal(fn(cancelBtn, modalEl, true), true, 'Cancel/✕ closes (down-on-backdrop irrelevant)');

    // Genuine backdrop click: down AND up on the backdrop.
    assert.equal(fn(modalEl, modalEl, true), true, 'backdrop down+up closes');

    // The reported bug: drag began inside a field (down NOT on backdrop), click
    // resolves to the backdrop on release — must NOT close.
    assert.equal(fn(modalEl, modalEl, false), false, 'drag-from-field release on backdrop does NOT close');

    // A click that lands on inner content never closes via the backdrop path.
    assert.equal(fn(innerEl, modalEl, true), false, 'click on inner content does not close');
});
