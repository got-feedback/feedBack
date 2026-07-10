// Source-level tests for highway.getFilteredNotes() / getFilteredChords() and
// the hasPhraseData() companion getter. These mirror the pattern used in
// highway_note_state.test.js: the createHighway closure is too heavy for a Node
// sandbox, so tests inspect the source text to lock in correct wiring.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const highwayJs = path.join(__dirname, '..', '..', 'static', 'highway.js');

test('highway public API exposes getFilteredNotes', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    assert.match(
        src,
        /getFilteredNotes\s*\(\s*\)\s*\{[^}]*_filteredNotes\s*!==\s*null/,
        'getFilteredNotes must check _filteredNotes !== null',
    );
});

test('getFilteredNotes falls through to notes when _filteredNotes is null', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    assert.match(
        src,
        /getFilteredNotes\s*\(\s*\)\s*\{[^}]*_filteredNotes[^}]*:\s*hwState\.notes/,
        'getFilteredNotes must return notes as fallback',
    );
});

test('highway public API exposes getFilteredChords', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    assert.match(
        src,
        /getFilteredChords\s*\(\s*\)\s*\{[^}]*_filteredChords\s*!==\s*null/,
        'getFilteredChords must check _filteredChords !== null',
    );
});

test('getFilteredChords falls through to chords when _filteredChords is null', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    assert.match(
        src,
        /getFilteredChords\s*\(\s*\)\s*\{[^}]*_filteredChords[^}]*:\s*hwState\.chords/,
        'getFilteredChords must return chords as fallback',
    );
});

test('highway public API exposes hasPhraseData', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    assert.match(
        src,
        /hasPhraseData\s*\(\s*\)\s*\{[^}]*_phrases/,
        'hasPhraseData must reference _phrases',
    );
});
