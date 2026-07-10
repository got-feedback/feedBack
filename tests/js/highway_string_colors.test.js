// User-created, shareable highway string colors. Two layers:
//   1. Source-level wiring guards (the createHighway / highway_3d closures own
//      canvas + WebGL lifecycle too heavy for a vm sandbox — same approach as
//      the other highway_* tests here), covering the 2D setStringColors API,
//      the 3D `custom` palette path, and the app.js color manager.
//   2. Executable behavior tests for the *pure* pieces — the dim/bright
//      derivation math and the share-code codec — extracted and run for real.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const highwayJs = path.join(__dirname, '..', '..', 'static', 'highway.js');
const highway3dJs = path.join(__dirname, '..', '..', 'plugins', 'highway_3d', 'screen.js');
const appJs = path.join(__dirname, '..', '..', 'static', 'app.js');

// Brace-balanced extraction (same helper shape as highway_note_state.test.js).
function extractBlock(src, signature) {
    const start = src.indexOf(signature);
    assert.ok(start !== -1, `signature '${signature}' not found`);
    const openBrace = src.indexOf('{', start);
    assert.ok(openBrace !== -1, `opening brace after '${signature}' not found`);
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    assert.ok(depth === 0, `unbalanced braces after '${signature}'`);
    return src.slice(start, i);
}

// ── 2D highway (static/highway.js) ────────────────────────────────────────

test('2D palette arrays are mutable (let) with frozen DEFAULT_* originals', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    assert.match(src, /const\s+DEFAULT_STRING_COLORS\s*=/, 'DEFAULT_STRING_COLORS must exist for reset');
    assert.match(src, /const\s+DEFAULT_STRING_DIM\s*=/, 'DEFAULT_STRING_DIM must exist for reset');
    assert.match(src, /const\s+DEFAULT_STRING_BRIGHT\s*=/, 'DEFAULT_STRING_BRIGHT must exist for reset');
    assert.match(src, /hwState\.STRING_COLORS\s*=\s*DEFAULT_STRING_COLORS\.slice\(\)/, 'STRING_COLORS must be a mutable copy of the defaults');
    assert.match(src, /hwState\.STRING_DIM\s*=\s*DEFAULT_STRING_DIM\.slice\(\)/, 'STRING_DIM must be a mutable copy of the defaults');
    assert.match(src, /hwState\.STRING_BRIGHT\s*=\s*DEFAULT_STRING_BRIGHT\.slice\(\)/, 'STRING_BRIGHT must be a mutable copy of the defaults');
});

test('2D public API exposes getStringColors / setStringColors', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    assert.match(src, /getStringColors\s*\(\s*\)\s*\{\s*return\s+hwState\.STRING_COLORS\.slice\(\)/, 'getStringColors must return a copy');
    const fn = extractBlock(src, 'setStringColors(arr)');
    // Each provided index sets base + derived dim/bright; missing → default.
    assert.match(fn, /hwState\.STRING_COLORS\[i\]\s*=\s*base/, 'setStringColors must set the base color');
    assert.match(fn, /hwState\.STRING_DIM\[i\]\s*=\s*_darken\(/, 'setStringColors must derive the dim variant');
    assert.match(fn, /hwState\.STRING_BRIGHT\[i\]\s*=\s*_lighten\(/, 'setStringColors must derive the bright variant');
    assert.match(fn, /hwState\.STRING_COLORS\[i\]\s*=\s*DEFAULT_STRING_COLORS\[i\]/, 'setStringColors must restore defaults for missing/invalid indices');
});

// ── 3D highway (plugins/highway_3d/screen.js) ─────────────────────────────

test('3D adds a custom palette path + h3dBgSetStringColors setter', () => {
    const src = fs.readFileSync(highway3dJs, 'utf8');
    assert.match(src, /window\.h3dBgSetStringColors\s*=/, 'window.h3dBgSetStringColors must be defined');
    assert.match(src, /_bgWriteGlobal\('customColors'/, 'setter must persist customColors');
    assert.match(src, /_bgWriteGlobal\('palette',\s*'custom'\)/, "setter must flip palette to 'custom'");
    // 'custom' must survive palette coercion (else it gets reset to default).
    assert.match(src, /key === 'palette'\)\s*return\s*\(PALETTE_IDS\.includes\(val\)\s*\|\|\s*val === 'custom'\)/, "palette coercion must accept 'custom'");
    // _bgLoadSettings resolves 'custom' into the in-place _customPalette and
    // forces a retint on content change via the signature guard.
    assert.match(src, /newPaletteId === 'custom'/, '_bgLoadSettings must branch on custom');
    assert.match(src, /_bgPaletteSig/, 'a palette content signature must guard in-place custom edits');
});

test('3D gem-body gradients follow the active palette (not hardcoded)', () => {
    const src = fs.readFileSync(highway3dJs, 'utf8');
    // The gem bodies (strings 0..5) are a baked per-vertex gradient; a custom
    // palette must recolor them, else gems/sustain/vibrato heads stay stock.
    assert.match(src, /function _recolorGemGradients\(\)/, '_recolorGemGradients must exist');
    const fn = extractBlock(src, 'function _recolorGemGradients()');
    assert.match(fn, /isCustom\s*&&\s*base !== PALETTES\.default\[s\]/, 'custom slots must derive stops from the base color');
    assert.match(fn, /_lightenInt\(base/, 'derived top highlight via _lightenInt');
    assert.match(fn, /_darkenInt\(base/, 'derived bottom shade via _darkenInt');
    assert.match(fn, /colAttr\.needsUpdate = true/, 'must flag the color attribute dirty');
    // Wired into both the build path and the live palette-change path.
    const apply = extractBlock(src, 'function _applyPaletteToMaterials()');
    assert.match(apply, /_recolorGemGradients\(\)/, '_applyPaletteToMaterials must recolor gems on palette change');
});

// ── Core color manager (static/app.js) ────────────────────────────────────

test('app.js color manager name-maps to both highways, with identity no-op + builtin guard', () => {
    const src = fs.readFileSync(appJs, 'utf8');
    const fn = extractBlock(src, 'function reapplyHighwayStringColors()');
    assert.match(fn, /_hwcMappingIsIdentity\(sc, isBass\)/, 'must short-circuit the identity (≤6-string / bass default) case');
    assert.match(fn, /h3d_bg_palette'\) !== 'default'\) window\.h3dBgSetPalette\?\.\('default'\)/, 'identity+default must put the 3D back on its default palette');
    assert.match(fn, /_hwcEffectiveIndexColors\(_hwcMergedSlotColors\(\), sc, isBass\)/, 'must translate merged (default+custom) slots → per-index colors');
    assert.match(fn, /window\.highway\?\.setStringColors\?\.\(eff\)/, 'must drive the 2D highway with translated colors');
    assert.match(fn, /window\.h3dBgSetStringColors\?\.\(eff\)/, 'must always drive the 3D highway (palette picker removed)');
    // identity = guitar ≤6 strings and 4-string bass; 7/8-string guitar and
    // 5/6-string bass remap defaults (they prepend lower strings).
    const idfn = extractBlock(src, 'function _hwcMappingIsIdentity(sc, isBass)');
    assert.match(idfn, /return isBass \? sc <= 4 : sc <= 6/, 'identity must be 4-string bass / ≤6-string guitar');
    // Re-apply on song load (string count can change the slot→index mapping).
    assert.match(src, /window\.feedBack\.on\('viz:renderer:ready', reapplyHighwayStringColors\)/, 'must re-apply when a viz renderer becomes ready');
    assert.match(src, /window\.feedBack\.on\('song:loaded', reapplyHighwayStringColors\)/, 'must re-apply on song load');
});

// ── Executable: dim/bright derivation math ────────────────────────────────

function loadColorMath() {
    const src = fs.readFileSync(highwayJs, 'utf8');
    const snippet = [
        extractBlock(src, 'function _clampByte(n)'),
        extractBlock(src, 'function _parseHex(hex)'),
        extractBlock(src, 'function _toHex(r, g, b)'),
        extractBlock(src, 'function _darken(hex, factor)'),
        extractBlock(src, 'function _lighten(hex, t)'),
        'return { _darken, _lighten, _parseHex };',
    ].join('\n');
    return new Function('Math', snippet)(Math);
}

test('_darken(0.40) reproduces the default DIM band for known colors', () => {
    const { _darken } = loadColorMath();
    // 204*0.40 = 81.6 → 82 = 0x52; matches DEFAULT_STRING_DIM[0] (#520000).
    assert.equal(_darken('#cc0000', 0.40), '#520000');
    // Green low E: 204→0x52, 102→0x29; matches DEFAULT_STRING_DIM[4] (#005229).
    assert.equal(_darken('#00cc66', 0.40), '#005229');
});

test('_lighten(0.30) produces a valid, brighter hex', () => {
    const { _lighten, _parseHex } = loadColorMath();
    const out = _lighten('#0066cc', 0.30);
    assert.match(out, /^#[0-9a-f]{6}$/, 'lighten must yield a #rrggbb string');
    const a = _parseHex('#0066cc'), b = _parseHex(out);
    assert.ok(b.r >= a.r && b.g >= a.g && b.b >= a.b, 'each channel must be >= the base');
    assert.ok(b.r + b.g + b.b > a.r + a.g + a.b, 'result must be overall brighter');
});

test('color helpers reject malformed input gracefully', () => {
    const { _darken } = loadColorMath();
    assert.equal(_darken('not-a-color', 0.4), 'not-a-color', 'invalid hex passes through unchanged');
});

// ── Executable: slot↔index translation + share-code codec ─────────────────

function loadManager() {
    const src = fs.readFileSync(appJs, 'utf8');
    const constLines = [
        "const HWC_HEX_RE = /^#[0-9a-fA-F]{6}$/;",
        "const HWC_SLOT_KEYS = ['highE','B','G','D','A','lowE','low7','low8'];",
    ].join('\n');
    const snippet = [
        constLines,
        extractBlock(src, 'function _hwcSlotKeysForChart(sc, isBass)'),
        extractBlock(src, 'function _hwcMappingIsIdentity(sc, isBass)'),
        extractBlock(src, 'function _hwcNormalize(slotMap)'),
        extractBlock(src, 'function encodeHighwayColorShare(name, slotMap)'),
        extractBlock(src, 'function decodeHighwayColorShare(code)'),
        'return { _hwcSlotKeysForChart, _hwcMappingIsIdentity, _hwcNormalize, encodeHighwayColorShare, decodeHighwayColorShare };',
    ].join('\n');
    const ctx = { btoa, atob, escape, unescape, encodeURIComponent, decodeURIComponent, JSON, Math };
    return new Function(...Object.keys(ctx), snippet)(...Object.values(ctx));
}

test('translation table keeps Low E stable across string counts', () => {
    const { _hwcSlotKeysForChart } = loadManager();
    // 6-string guitar: index 0 = Low E.
    assert.equal(_hwcSlotKeysForChart(6, false)[0], 'lowE');
    // 7-string guitar: index 0 = Low B, index 1 = Low E (Low E keeps its slot).
    assert.deepEqual(_hwcSlotKeysForChart(7, false).slice(0, 2), ['low7', 'lowE']);
    // 8-string: index 0 = Low F#, index 2 = Low E.
    assert.equal(_hwcSlotKeysForChart(8, false)[2], 'lowE');
    // 4-string bass: index 0 = Low E (shares the low strings with guitar).
    assert.deepEqual(_hwcSlotKeysForChart(4, true), ['lowE', 'A', 'D', 'G']);
    // 5-string bass: index 0 = Low B, then Low E A D G.
    assert.deepEqual(_hwcSlotKeysForChart(5, true), ['low7', 'lowE', 'A', 'D', 'G']);
    // High E is the top guitar slot for 6/7/8-string.
    for (const sc of [6, 7, 8]) {
        const keys = _hwcSlotKeysForChart(sc, false);
        assert.equal(keys[keys.length - 1], 'highE', `${sc}-string top = High E`);
    }
});

test('identity mapping = 4-string bass and ≤6-string guitar only', () => {
    const { _hwcMappingIsIdentity, _hwcSlotKeysForChart } = loadManager();
    // Identity cases: name order == index order (so defaults stay stock).
    for (const [sc, bass] of [[6, false], [4, false], [4, true], [1, false]]) {
        assert.ok(_hwcMappingIsIdentity(sc, bass), `${sc}/${bass ? 'bass' : 'gtr'} should be identity`);
        assert.equal(_hwcSlotKeysForChart(sc, bass)[0], 'lowE', 'identity charts start at Low E');
    }
    // Non-identity: extended-range guitar AND bass prepend lower strings.
    for (const [sc, bass] of [[7, false], [8, false], [5, true], [6, true]]) {
        assert.ok(!_hwcMappingIsIdentity(sc, bass), `${sc}/${bass ? 'bass' : 'gtr'} should remap`);
        assert.notEqual(_hwcSlotKeysForChart(sc, bass)[0], 'lowE', 'extended charts start below Low E');
    }
});

test('_hwcNormalize keeps only valid named slots', () => {
    const { _hwcNormalize } = loadManager();
    const out = _hwcNormalize({ lowE: '#ABCDEF', A: 'garbage', B: '#123', highE: '#00ff00', bogus: '#111111' });
    assert.equal(out.lowE, '#abcdef', 'valid hex lowercased');
    assert.equal(out.highE, '#00ff00');
    assert.ok(!('A' in out), 'non-hex dropped');
    assert.ok(!('B' in out), '3-digit hex rejected by strict regex');
    assert.ok(!('bogus' in out), 'unknown slot dropped');
});

test('share code round-trips name + named slot colors', () => {
    const { encodeHighwayColorShare, decodeHighwayColorShare, _hwcNormalize } = loadManager();
    const colors = { lowE: '#ff0000', A: '#00ff00', highE: '#0000ff' };
    const code = encodeHighwayColorShare('Neon Test', colors);
    assert.match(code, /^SLOPHWY2\./, 'code must carry the versioned prefix');
    assert.ok(!/[+/=]/.test(code), 'code must be base64url (no +, /, =)');
    const out = decodeHighwayColorShare(code);
    assert.equal(out.name, 'Neon Test');
    assert.deepEqual(out.colors, _hwcNormalize(colors));
});

test('decodeHighwayColorShare returns null on garbage / wrong shape', () => {
    const { decodeHighwayColorShare, encodeHighwayColorShare } = loadManager();
    assert.equal(decodeHighwayColorShare('not a real code'), null);
    assert.equal(decodeHighwayColorShare(''), null);
    assert.equal(decodeHighwayColorShare(null), null);
    // A legacy array-shaped payload (old index-based format) is rejected.
    const arrayPayload = 'SLOPHWY2.' + btoa(JSON.stringify({ n: 'x', c: ['#ff0000'] })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    assert.equal(decodeHighwayColorShare(arrayPayload), null, 'array c is rejected (named-map only)');
    // A non-v2 prefix is rejected even with an otherwise-valid v2-shaped payload.
    const v1ish = 'SLOPHWY1.' + btoa(JSON.stringify({ n: 'x', c: { lowE: '#ff0000' } })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    assert.equal(decodeHighwayColorShare(v1ish), null, 'non-v2 prefix is rejected');
});
