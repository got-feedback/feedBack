'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'static', 'app.js'), 'utf8');
const m = src.match(/\/\* @pure:editor-pending-view:start \*\/[\s\S]*?\/\* @pure:editor-pending-view:end \*\//);
if (!m) throw new Error('pending-view helper block not found');

const api = new Function('"use strict";' + m[0] + '\nreturn { _buildEditorPendingViewPure };')();

test('edit-region handoff defaults cursor to region start and marks return path', () => {
    const out = api._buildEditorPendingViewPure('song.sloppak', 2, { a: 12.5, b: 20 }, { returnToHighway: true });
    assert.deepStrictEqual(out, {
        filename: 'song.sloppak',
        arrangement: 2,
        barSel: { startTime: 12.5, endTime: 20 },
        returnToHighway: true,
        cursorTime: 12.5,
    });
});

test('return-trip handoff preserves explicit viewport state', () => {
    const out = api._buildEditorPendingViewPure('song.sloppak', 1, { a: 8, b: 14 }, {
        scrollX: -4,
        zoom: 160,
        cursorTime: 9.25,
    });
    assert.deepStrictEqual(out, {
        filename: 'song.sloppak',
        arrangement: 1,
        barSel: { startTime: 8, endTime: 14 },
        cursorTime: 9.25,
        scrollX: 0,
        zoom: 160,
    });
});

test('missing region still produces a stable pending view shell', () => {
    const out = api._buildEditorPendingViewPure('song.sloppak', -1, null, {});
    assert.deepStrictEqual(out, {
        filename: 'song.sloppak',
        arrangement: 0,
        barSel: null,
    });
});
