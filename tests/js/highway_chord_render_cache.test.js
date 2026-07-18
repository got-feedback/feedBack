// Source-level guards for the 2D highway chord render cache
// (`_ensureChordRenderCache`). Locks in the invalidation contract so a
// regression that drops one of the three keys, or forgets to reset the
// derived state, will fail in CI.
//
// Background: see feedBack#412 and the Copilot review thread that
// surfaced the `chordTemplates` ordering edge case (templates can land
// after the final `chords` chunk; `isOpen()`-derived `nonZeroNotes`
// would otherwise stay stale until the next chord transition).
//
// Like the other highway tests in this directory, these inspect the
// source rather than executing — the createHighway() closure owns
// canvas + WebGL lifecycle that's too heavy for a vm sandbox.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const highwayJs = path.join(__dirname, '..', '..', 'static', 'highway.js');


// R3c: highway.js is being carved into modules, so its source is no longer ONE file. Read the
// whole set rather than re-pinning at whichever file currently holds a function — re-pinning
// just breaks again next time, and a source-shape assertion that silently stops finding its
// target is indistinguishable from one that passes.
function highwaySources() {
    const root = path.join(__dirname, '..', '..');
    const jsDir = path.join(root, 'static', 'js');
    const parts = [fs.readFileSync(path.join(root, 'static', 'highway.js'), 'utf8')];
    for (const f of fs.readdirSync(jsDir).sort()) {
        if (f.startsWith('highway-') && f.endsWith('.js')) parts.push(fs.readFileSync(path.join(jsDir, f), 'utf8'));
    }
    return parts.join('\n');
}

test('_ensureChordRenderCache keys off src, _inverted, AND chordTemplates', () => {
    const src = highwaySources();
    // The cache key triple must include chordTemplates — without it, a
    // late-arriving `chord_templates` WS message leaves cached
    // nonZeroNotes / nonZeroFrets stale until the next chord transition.
    //
    // Match either operand order (`A === B` or `B === A`) so a future
    // stylistic refactor that flips sides doesn't trip these guards —
    // the semantic invariant is the comparison, not its placement.
    const eqEither = (a, b) => new RegExp(
        `\\b${a}\\b\\s*===\\s*\\b${b}\\b|\\b${b}\\b\\s*===\\s*\\b${a}\\b`
    );
    const neqEither = (a, b) => new RegExp(
        `\\b${a}\\b\\s*!==\\s*\\b${b}\\b|\\b${b}\\b\\s*!==\\s*\\b${a}\\b`
    );
    assert.match(src, eqEither('hwState\\._chordRenderCacheSrc', 'src'), 'cache must key on src');
    assert.match(src, eqEither('hwState\\._chordRenderCacheInverted', 'hwState\\._inverted'), 'cache must key on _inverted');
    // Since the chart-transform tier landed, the cache keys on the
    // EFFECTIVE templates (staged transform output ?? chordTemplates) —
    // identity change on either side invalidates.
    assert.match(src, neqEither('hwState\\._chordRenderCacheTemplates', 'effTemplates'),
        'cache must key on the effective chordTemplates (detected via !== for change-flag)');
    assert.match(src, /_effChordTemplates\(hwState\)\s*\{\s*\n?\s*return hwState\._xfChordTemplates !== null \? hwState\._xfChordTemplates : hwState\.chordTemplates;/,
        'effective templates must derive from hwState.chordTemplates');
});

test('chordTemplates change resets fretline preview and frame-mismatch warner', () => {
    const src = highwaySources();
    // The cache-invalidation block must clear both _chordFretLineNotes
    // (so _updateFretLinePreview re-publishes with corrected isOpen
    // classification) and _frameMismatchWarned (so a chord ID warned
    // against stale templates re-validates against the corrected ones).
    // Non-greedy `[\s\S]*?` instead of `[^}]*` so a future nested
    // block inside the `if (templatesChanged) { … }` branch (e.g. an
    // inner conditional reset) doesn't break the match by introducing
    // a `}` before the symbol we're checking for.
    assert.match(src, /if\s*\(\s*templatesChanged\s*\)\s*\{[\s\S]*?hwState\._chordFretLineNotes\s*=\s*\[\][\s\S]*?\}/,
        'templatesChanged branch must reset _chordFretLineNotes');
    assert.match(src, /if\s*\(\s*templatesChanged\s*\)\s*\{[\s\S]*?hwState\._lastChordOnFretLine\s*=\s*null[\s\S]*?\}/,
        'templatesChanged branch must null _lastChordOnFretLine');
    assert.match(src, /if\s*\(\s*templatesChanged\s*\)\s*\{[\s\S]*?_frameMismatchWarned\.clear\(\)[\s\S]*?\}/,
        'templatesChanged branch must clear _frameMismatchWarned');
});
