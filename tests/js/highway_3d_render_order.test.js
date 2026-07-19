// Pins the renderOrder hierarchy in plugins/highway_3d/screen.js.
//
// Three.js renders transparent objects by renderOrder first, then back-to-front
// Z sort within the same renderOrder. Nearly all 3D-highway materials use
// depthTest:false (exceptions exist — e.g. the accent halo mats set
// depthTest:true), so renderOrder is the primary draw-order control — getting it wrong silently
// causes one layer to bleed through another (gems clipping through chord frames,
// strings buried under notes, etc.).
//
// Full hierarchy bottom → top:
//
//   -1   background stage traversal
//    1   lane quads
//    2   fret dividers
//    3   fret inlay dots (above the lane so it no longer hides them)
//    4   sus-rail bloom (pSusRailBloom seed)           ← highway_3d_sustain_bloom.test.js
//    5   sus-rail core (pSusRail seed)                 ← highway_3d_sustain_rail.test.js
//    7   string-line glows (in-lane glow lines)
//   14   board-projection frame
//   [renderOrderForLayerAtZ(z, FRET_COLUMN)] fret-column markers (pFretColMarker) — between chord frame and gem
//   [layered below chordFrameRenderOrder] chord fill / PM-FH fill / PM-FH lines
//   [chordFrameRenderOrder] chord frame edges = renderOrderForLayerAtZ(z, CHORD_FRAME)
//   [layered above chordFrameRenderOrder] chord-frame glow, connector/drop lines
//   [below chordFrameRenderOrder] sustain-trail strip segments (Z-proportional, always < frame)
//   [renderOrderForLayerAtZ(noteZ, NOTE_OUTLINE)] note gem outline
//   [renderOrderForLayerAtZ(noteZ, NOTE_CORE)] note gem core
//   [techniqueMarkerRenderOrder] technique markers
//   [after board wire layers] note fret labels, above gem symbols and fret wires
//   [renderOrderForLayerAtZ(0, BOARD_STRING)]    string mesh (drawn over gems but under fret wires)
//   [renderOrderForLayerAtZ(0, BOARD_FRET_WIRE)] static fret wires (above strings, as on a real guitar)
//   1000             technique labels, ghost-fret overlay
//
// Tests are source-level regex checks — no need to load Three.js or a DOM.
//
// Any PR that changes a renderOrder value must update the relevant test(s) here
// and provide a visual justification in the PR description.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCREEN_JS = path.join(__dirname, '..', '..', 'plugins', 'highway_3d', 'screen.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _src;
/** Returns the cached 3D highway screen source under test. */
function src() {
    if (!_src) _src = fs.readFileSync(SCREEN_JS, 'utf8');
    return _src;
}

/** Parses the declared render-order layer stack from screen.js. */
function layers() {
    const match = src().match(/const\s+RENDER_ORDER_LAYER_STACK\s*=\s*Object\.freeze\(\s*\[([\s\S]*?)\]\s*\)/);
    assert.ok(match, 'RENDER_ORDER_LAYER_STACK must be declared');
    return Array.from(match[1].matchAll(/'([^']+)'/g), m => m[1]);
}

/** Returns the position of a named layer in the render-order stack. */
function layerIndex(name) {
    const ordered = layers();
    const idx = ordered.indexOf(name);
    assert.ok(idx !== -1, `${name} must be present in RENDER_ORDER_LAYER_STACK`);
    return idx;
}

/** Reads the render-order base used for objects at z = 0. */
function zZeroRenderOrder() {
    const match = src().match(/const\s+RENDER_ORDER_AT_Z_ZERO\s*=\s*(-?\d+(?:\.\d+)?)\s*;/);
    assert.ok(match, 'RENDER_ORDER_AT_Z_ZERO must be declared');
    return Number(match[1]);
}

// ---------------------------------------------------------------------------
// Static / fixed renderOrder values
// ---------------------------------------------------------------------------

test('lane quads use renderOrder 1', () => {
    assert.match(
        src(),
        /lane\.renderOrder\s*=\s*1\s*;/,
        'lane quads must use renderOrder = 1 (bottom-most visible layer)',
    );
});

test('fret dividers use renderOrder 2', () => {
    assert.match(
        src(),
        /div\.renderOrder\s*=\s*2\s*;/,
        'fret dividers must use renderOrder = 2, above lane (1)',
    );
});

test('fret inlay dots use renderOrder 3, above lane (1) and dividers (2)', () => {
    // The translucent lane would otherwise paint over and hide the inlay.
    // The dots must draw after the lane/dividers but stay below the depth-layer stack.
    assert.match(
        src(),
        /d\.renderOrder\s*=\s*3\s*;/,
        'fret inlay dots must use renderOrder = 3 so the lane no longer hides them',
    );
});

test('string-line glows use renderOrder 7, above sus-rails (4/5)', () => {
    // The in-lane string glow lines sit at 7 — above sus-rail bloom (4) and
    // core (5) so the glow is visible, but below chord fill (chordFrameRenderOrder-4,
    // min=44) so chord interiors don't disappear behind glow overdraw.
    assert.match(
        src(),
        /line\.renderOrder\s*=\s*7\s*;/,
        'string glow lines must use renderOrder = 7',
    );
});

test('board-projection frame mesh uses renderOrder 14', () => {
    // The fretboard projection plane sits above string glows (7) but below
    // chord fill (min 44). Value 14 keeps it sandwiched cleanly.
    // Anchor to the board-projection pool (projMeshArr = activePalette.map(...))
    // so the assertion only passes when THAT block seeds renderOrder = 14 —
    // not any unrelated renderOrder = 14 elsewhere in the source.
    const boardProjRO = /projMeshArr\s*=\s*activePalette\.map\b[\s\S]{0,1200}?m\.renderOrder\s*=\s*14\s*;/;
    assert.match(
        src(),
        boardProjRO,
        'board-projection pool (projMeshArr) must seed meshes with renderOrder = 14',
    );
    const boardMatch = src().match(boardProjRO);
    assert.ok(boardMatch, 'board projection mesh must be assigned renderOrder = 14');
});

test('string mesh in buildBoard uses the named board-string layer', () => {
    // The physical string cylinders/planes rendered on the fretboard sit above
    // the note-gem layers but below fret wires.
    assert.match(
        src(),
        /mesh\.renderOrder\s*=\s*renderOrderForLayerAtZ\(\s*0\s*,\s*'BOARD_STRING'\s*\)\s*;/,
        'buildBoard string mesh must use BOARD_STRING',
    );
    assert.ok(layerIndex('BOARD_STRING') > layerIndex('TECHNIQUE_MARKER'));
    assert.ok(layerIndex('BOARD_STRING') < layerIndex('BOARD_FRET_WIRE'));
});

test('static fret wires use bowed TubeGeometry + MeshStandardMaterial, named board-fret-wire layer, depthTest+depthWrite false, idle tier FRET_WIRE_IDLE_HEX', () => {
    // Fret wires are a single shared, bowed TubeGeometry (backported from
    // highway_babylon): a CatmullRom curve whose middle pushes away from the
    // camera by FRET_BOW_DZ so the row of frets reads as wrapping a cylindrical
    // neck. T.Line is avoided — WebGL ignores linewidth > 1px so a Line always
    // renders as a hairline. The lit MeshStandardMaterial lets scene light glint
    // across the rounded surface (gold in-anchor → brass). depthTest:false is
    // required: the string BoxGeometry (MeshStandardMaterial, depthWrite:true)
    // writes depth at Z = +STR_THICK/2, so fret wires near Z=0 would fail the
    // depth test at string pixels despite the higher layer; depthWrite:false
    // keeps the transparent fret from polluting depth for later overlays.
    const s = src();
    assert.match(
        s,
        /new\s+T\.TubeGeometry\(\s*tubeCurve\s*,\s*FRET_TUBE_SEG\s*,\s*FRET_TUBE_RADIUS\s*,\s*FRET_TUBE_RADIAL\s*,\s*false\s*,?\s*\)/,
        'buildBoard fret wires must use a TubeGeometry built from tubeCurve + FRET_TUBE_* params',
    );
    assert.match(
        s,
        /new\s+T\.CatmullRomCurve3\(\s*tubePath\s*\)/,
        'buildBoard fret tube must follow a CatmullRomCurve3 through the bowed path',
    );
    assert.match(
        s,
        /FRET_BOW_DZ\s*\*\s*zm/,
        'fret tube path must bow in Z by FRET_BOW_DZ so the neck reads as curved',
    );
    assert.match(
        s,
        /new\s+T\.Mesh\(\s*fretTubeGeo\s*,\s*mat\s*\)/,
        'buildBoard fret wires must reuse the shared fretTubeGeo (not T.Line)',
    );
    assert.match(
        s,
        /fw\.renderOrder\s*=\s*renderOrderForLayerAtZ\(\s*0\s*,\s*'BOARD_FRET_WIRE'\s*\)\s*;/,
        'buildBoard fret wire mesh must use BOARD_FRET_WIRE',
    );
    assert.match(
        s,
        /new\s+T\.MeshStandardMaterial\(/,
        'fret wires must use MeshStandardMaterial so scene light shades the metal',
    );
    // The wire tiers moved to named constants (feedBack#969): idle is the
    // dimmed 0x4A4A60 so the neck recedes and the anchor lane reads as the
    // focus cue. Assert the material uses the constant AND pin the constant's
    // value, so a retune is a deliberate two-line change here.
    assert.match(
        s,
        /color\s*:\s*FRET_WIRE_IDLE_HEX/,
        'fret wire material must take its default color from FRET_WIRE_IDLE_HEX',
    );
    assert.match(
        s,
        /FRET_WIRE_IDLE_HEX\s*=\s*0x4A4A60/,
        'FRET_WIRE_IDLE_HEX must be the dimmed idle gray-violet 0x4A4A60',
    );
    // Both depth flags anchored to the fret-wire material literal (via its
    // FRET_WIRE_IDLE_HEX color, unique to it) — an unscoped match would pass
    // off any other depthTest:false material in the file. Asserted as two
    // separate anchored matches so property order inside the literal still
    // isn't pinned.
    assert.match(
        s,
        /color\s*:\s*FRET_WIRE_IDLE_HEX[\s\S]{0,400}?depthTest\s*:\s*false/,
        'the fret wire material itself must set depthTest: false',
    );
    assert.match(
        s,
        /color\s*:\s*FRET_WIRE_IDLE_HEX[\s\S]{0,400}?depthWrite\s*:\s*false/,
        'the fret wire material itself must set depthWrite: false (no z-buffer pollution)',
    );
    assert.match(
        s,
        /fretWireMats\s*\[\s*f\s*\]\s*=\s*mat\s*;/,
        'buildBoard must store each wire material in fretWireMats[f]',
    );
});

test('update() sets fret wire FRET_WIRE_ACTIVE_HEX (gold) for in-anchor frets, FRET_WIRE_IDLE_HEX otherwise', () => {
    // Uses anchorLaneBoundsAt() — the same helper the dynamic lane uses —
    // so fret wire highlight aligns exactly with the lane edges:
    //   dMin = fret - 1,  dMax = fret + width - 1
    // Example: { fret: 3, width: 4 } → dMin=2, dMax=6 → wires 2..6 gold.
    const s = src();
    assert.match(
        s,
        /fretWireMats\.length/,
        'update() must guard the per-frame fret wire loop on fretWireMats.length',
    );
    assert.match(
        s,
        /anchorLaneBoundsAt\(\s*anchors\s*,\s*now\s*\)/,
        'update() must use anchorLaneBoundsAt(anchors, now) to get fret wire range',
    );
    assert.match(
        s,
        /_m\.color\.setHex\(\s*FRET_WIRE_ACTIVE_HEX\s*\)/,
        'update() must set FRET_WIRE_ACTIVE_HEX for in-anchor fret wires',
    );
    assert.match(
        s,
        /FRET_WIRE_ACTIVE_HEX\s*=\s*0xD8A636/,
        'FRET_WIRE_ACTIVE_HEX must stay the anchor-lane gold 0xD8A636',
    );
    assert.match(
        s,
        /_m\.color\.setHex\(\s*FRET_WIRE_IDLE_HEX\s*\)/,
        'update() must set FRET_WIRE_IDLE_HEX for out-of-anchor fret wires',
    );
    assert.match(
        s,
        /_fwBounds\.dMin/,
        'update() must use dMin from anchorLaneBoundsAt (= fret - 1)',
    );
    assert.match(
        s,
        /_fwBounds\.dMax/,
        'update() must use dMax from anchorLaneBoundsAt (= fret + width - 1)',
    );
});

test('fret-column markers use Z-proportional renderOrder between chord frame and gem', () => {
    // pFretColMarker labels use the named stack: one step above chord frame
    // and one step below note gems at the same depth.
    // This ensures chord frame borders never overdraw the label and the label
    // never overdraws gems, at every Z position across the lookahead window.
    assert.match(
        src(),
        /sp\.renderOrder\s*=\s*renderOrderForLayerAtZ\(\s*z\s*,\s*'FRET_COLUMN'\s*\)\s*;/,
        'pFretColMarker renderOrder must use renderOrderForLayerAtZ(z, FRET_COLUMN)',
    );
    assert.ok(layerIndex('FRET_COLUMN') > layerIndex('CHORD_FRAME'));
    assert.ok(layerIndex('FRET_COLUMN') < layerIndex('NOTE_OUTLINE'));
});

test('technique labels and ghost-fret overlay use renderOrder 1000', () => {
    // 1000 is well above the entire Z-proportional range and the
    // string/cadence layer — labels must always be readable.
    const matches = src().match(/m\.renderOrder\s*=\s*1000\s*;/g) || [];
    assert.ok(
        matches.length >= 2,
        'at least two renderOrder = 1000 assignments must exist (technique labels + ghost fret)',
    );
});

// ---------------------------------------------------------------------------
// Z-proportional formulas — chord frame / note gem / technique marker
// ---------------------------------------------------------------------------

test('chordFrameRenderOrder uses renderOrderForLayerAtZ(z, CHORD_FRAME)', () => {
    // Per-chord frame renderOrder mirrors the note-gem scale with an earlier
    // layer from RENDER_ORDER_LAYER_STACK.
    assert.match(
        src(),
        /const\s+chordFrameRenderOrder\s*=\s*renderOrderForLayerAtZ\(\s*z\s*,\s*'CHORD_FRAME'\s*\)\s*;/,
        'chordFrameRenderOrder must use renderOrderForLayerAtZ(z, CHORD_FRAME)',
    );
    assert.match(src(), /const\s+RENDER_ORDER_LAYER_INDEX\s*=\s*Object\.freeze\(\s*RENDER_ORDER_LAYER_STACK\.reduce\(/);
    assert.match(src(), /const\s+layerIndex\s*=\s*RENDER_ORDER_LAYER_INDEX\[layerName\]\s*;/);
    assert.match(src(), /if\s*\(\s*layerIndex\s*===\s*undefined\s*\)\s*throw\s+new\s+Error\(`Unknown 3D highway depth layer: \$\{layerName\}`\)\s*;/);
    assert.match(src(), /const\s+depthRenderOrder\s*=\s*Math\.max\(\s*RENDER_ORDER_FAR_CLAMP\s*,\s*Math\.round\(\s*RENDER_ORDER_AT_Z_ZERO\s*\+\s*worldZ\s*\/\s*K\s*\)\s*\)\s*;/);
    // Layer is a sub-unit fraction so the integer depth bucket strictly
    // dominates (a farther object can't outrank a nearer one via a higher
    // layer); the layer only breaks ties within the same depth bucket.
    assert.match(src(), /return\s+depthRenderOrder\s*\+\s*layerIndex\s*\/\s*RENDER_ORDER_LAYER_STACK\.length\s*;/);
    assert.ok(layerIndex('CHORD_FRAME') < layerIndex('NOTE_OUTLINE'));
});

test('note outline uses renderOrderForLayerAtZ(noteZ, NOTE_OUTLINE)', () => {
    // Per-note gem renderOrder. noteZ is negative (ahead of hit line → negative
    // Z in world space). At noteZ=0 (on the hit line), the note outline uses
    // the near render-order base plus its layer index; far notes clamp to the
    // far render-order base plus that same layer index.
    // The ordered layer list keeps gems above chord frames everywhere.
    assert.match(
        src(),
        /outline\.renderOrder\s*=\s*renderOrderForLayerAtZ\(\s*noteZ\s*,\s*'NOTE_OUTLINE'\s*\)\s*;/,
        'note outline must use renderOrderForLayerAtZ(noteZ, NOTE_OUTLINE)',
    );
    assert.strictEqual(layerIndex('CHORD_FILL'), 0);
});

test('techniqueMarkerRenderOrder uses the named technique marker layer above gem core', () => {
    // Technique markers (PM cross, bend arrow, H/P chevron, etc.) must overlay
    // the gem itself.
    assert.match(
        src(),
        /const\s+techniqueMarkerRenderOrder\s*=\s*renderOrderForLayerAtZ\(\s*noteZ\s*,\s*'TECHNIQUE_MARKER'\s*\)/,
        'techniqueMarkerRenderOrder must use TECHNIQUE_MARKER',
    );
    assert.ok(layerIndex('TECHNIQUE_MARKER') > layerIndex('NOTE_CORE'));
});

// ---------------------------------------------------------------------------
// Intra-chord layering (chord fill < PM/FH fill < PM/FH lines < frame edge)
// ---------------------------------------------------------------------------

test('chord fill interior uses the named layer below chord frame', () => {
    // The translucent chord-box fill sits below the frame edge so the edge
    // always wins when both cover the same pixel.
    assert.match(
        src(),
        /fill\.renderOrder\s*=\s*renderOrderForLayerAtZ\(\s*z\s*,\s*'CHORD_FILL'\s*\)\s*;/,
        'chord fill must use CHORD_FILL',
    );
    assert.ok(layerIndex('CHORD_FILL') < layerIndex('CHORD_FRAME'));
});

test('PM/FH X fill (pPMXFill / pFHXFill) uses its ordered layer', () => {
    // The black background fill of the muted-note X symbol is above chord fill
    // but below the X lines — same chord, so same chord-frame renderOrder base.
    const matches = src().match(/xf\.renderOrder\s*=\s*renderOrderForLayerAtZ\(\s*z\s*,\s*'CHORD_STRUM_FILL'\s*\)\s*;/g) || [];
    assert.ok(
        matches.length >= 2,
        'both PM and FH X-fill meshes must use CHORD_STRUM_FILL (found ' + matches.length + ')',
    );
    assert.ok(layerIndex('CHORD_FILL') < layerIndex('CHORD_STRUM_FILL'));
    assert.ok(layerIndex('CHORD_STRUM_FILL') < layerIndex('CHORD_STRUM_LINE'));
});

test('PM/FH X lines (pMuteXLines / pFHXLines) use their ordered layer', () => {
    // The coloured X stroke lines are above the black fill but below
    // the chord frame border edge, so they don't escape the box.
    const matches = src().match(/xl\.renderOrder\s*=\s*renderOrderForLayerAtZ\(\s*z\s*,\s*'CHORD_STRUM_LINE'\s*\)\s*;/g) || [];
    assert.ok(
        matches.length >= 2,
        'both PM and FH X-line meshes must use CHORD_STRUM_LINE (found ' + matches.length + ')',
    );
    assert.ok(layerIndex('CHORD_STRUM_LINE') < layerIndex('CHORD_FRAME'));
});

test('chord frame glow uses the layer after chord frame', () => {
    // Accent glow draws after the frame while still remaining below connectors
    // and note symbols in the ordered layer list.
    assert.match(
        src(),
        /b\.renderOrder\s*=\s*renderOrderForLayerAtZ\(\s*z\s*,\s*'CHORD_EDGE_GLOW'\s*\)\s*;/,
        'chord frame edge slabs must use CHORD_EDGE_GLOW',
    );
    assert.ok(layerIndex('CHORD_EDGE_GLOW') > layerIndex('CHORD_FRAME'));
    assert.ok(layerIndex('CHORD_EDGE_GLOW') < layerIndex('CONNECTOR_LINE'));
});

// ---------------------------------------------------------------------------
// Sustain-trail strip & ribbon — always below chord frame of same depth
// ---------------------------------------------------------------------------

test('sus-trail strip renderOrder formula keeps trails strictly below chord frames at same Z', () => {
    // Sustain trails use the ordered layer immediately below chord frames at
    // the same depth.
    assert.match(
        src(),
        /const\s+trailRenderOrder\s*=\s*renderOrderForLayerAtZ\(\s*Math\.min\(\s*0\s*,\s*zCenter\s*\)\s*,\s*'SUSTAIN_TRAIL'\s*\)\s*;/,
        'sus-trail strip renderOrder must use renderOrderForLayerAtZ(min zCenter, SUSTAIN_TRAIL)',
    );
    assert.ok(layerIndex('SUSTAIN_TRAIL') < layerIndex('CHORD_FRAME'));
});

test('sus-trail ribbon renderOrder formula mirrors strip formula using time-based depth', () => {
    // Ribbons use _ribDt (time from now to ribbon midpoint) converted to the
    // same Z scale as dZ() on the sustain-trail layer.
    assert.match(
        src(),
        /const\s+ribbonRenderOrder\s*=\s*renderOrderForLayerAtZ\(\s*-\s*_ribDt\s*\*\s*TS\s*,\s*'SUSTAIN_TRAIL'\s*\)\s*;/,
        'sus-trail ribbon renderOrder must use renderOrderForLayerAtZ on the sustain-trail layer',
    );
});

// ---------------------------------------------------------------------------
// Note gem ordering (outline < core, both driven by named depth layers)
// ---------------------------------------------------------------------------

test('note gem outline uses the named outline layer', () => {
    assert.match(
        src(),
        /outline\.renderOrder\s*=\s*renderOrderForLayerAtZ\(\s*noteZ\s*,\s*'NOTE_OUTLINE'\s*\)\s*;/,
        'note gem outline must use NOTE_OUTLINE',
    );
    assert.ok(layerIndex('NOTE_OUTLINE') > layerIndex('FRET_COLUMN'));
});

test('note gem core uses the named layer above outline', () => {
    assert.match(
        src(),
        /core\.renderOrder\s*=\s*renderOrderForLayerAtZ\(\s*noteZ\s*,\s*'NOTE_CORE'\s*\)\s*;/,
        'note gem core must use NOTE_CORE',
    );
    assert.ok(layerIndex('NOTE_CORE') > layerIndex('NOTE_OUTLINE'));
});

// ---------------------------------------------------------------------------
// Key relative-ordering invariants (derived constants)
// ---------------------------------------------------------------------------

test('chord frame layer is below note outline layer', () => {
    // Chord frames must always render below note gems, even at maximum depth
    // (far end of the lookahead).
    //
    assert.ok(layerIndex('CHORD_FRAME') < layerIndex('NOTE_OUTLINE'));
});

test('fret labels are above note symbols in the named stack', () => {
    assert.ok(layerIndex('NOTE_FRET_LABEL') > layerIndex('NOTE_CORE'), 'note fret labels must draw above gem core');
    assert.ok(layerIndex('NOTE_FRET_LABEL') > layerIndex('TECHNIQUE_MARKER'), 'note fret labels must draw above technique markers');
    assert.ok(layerIndex('ARP_NOTE_FRET_LABEL') > layerIndex('NOTE_FRET_LABEL'), 'arp labels retain a one-layer tie-breaker');
    assert.ok(layerIndex('CHORD_FRET_LABEL') > layerIndex('NOTE_CORE'), 'chord-loop fret labels must draw above gem core at the same depth');
    assert.ok(layerIndex('NOTE_FRET_LABEL') > layerIndex('BOARD_FRET_WIRE'), 'note fret labels must clear static fret wires');
    assert.ok(layerIndex('CHORD_FRET_LABEL') > layerIndex('BOARD_FRET_WIRE'), 'chord fret labels must clear static fret wires');
});

test('string mesh layer is above note symbols and below labels', () => {
    // Board strings are never occluded by flying gems, but labels still appear above strings.
    const s = src();
    assert.match(s, /mesh\.renderOrder\s*=\s*renderOrderForLayerAtZ\(\s*0\s*,\s*'BOARD_STRING'\s*\)\s*;/, 'string mesh must use BOARD_STRING');
    // Confirm 1000 also exists (labels above strings)
    assert.match(s, /m\.renderOrder\s*=\s*1000\s*;/, 'technique label renderOrder 1000 must exist');
    assert.ok(layerIndex('BOARD_STRING') > layerIndex('TECHNIQUE_MARKER'), 'string mesh layer must be above note symbols');
    assert.ok(layerIndex('BOARD_STRING') < layerIndex('NOTE_FRET_LABEL'), 'string mesh layer must be below fret labels');
});

test('fret-column marker layer is above chord frame and below gem outline', () => {
    assert.ok(layerIndex('FRET_COLUMN') > layerIndex('CHORD_FRAME'), 'fret-column marker layer must be above chord frame');
    assert.ok(layerIndex('FRET_COLUMN') < layerIndex('NOTE_OUTLINE'), 'fret-column marker layer must be below gem outline');
    assert.match(src(), /renderOrderForLayerAtZ\(\s*z\s*,\s*'FRET_COLUMN'\s*\)/);
});

test('static fret wire layer is above string mesh and note symbols', () => {
    // Structural invariant: fret wires must always draw after (on top of) strings.
    assert.ok(layerIndex('BOARD_FRET_WIRE') > layerIndex('BOARD_STRING'), 'fret wire must be above string mesh');
    assert.ok(layerIndex('BOARD_FRET_WIRE') > layerIndex('TECHNIQUE_MARKER'), 'fret wire must be above note symbols');
    assert.ok(zZeroRenderOrder() + layerIndex('BOARD_FRET_WIRE') < 1000, 'fret wire must be below technique labels (1000)');
    assert.match(src(), /fw\.renderOrder\s*=\s*renderOrderForLayerAtZ\(\s*0\s*,\s*'BOARD_FRET_WIRE'\s*\)\s*;/, 'buildBoard fret wire must use BOARD_FRET_WIRE');
    assert.match(src(), /mesh\.renderOrder\s*=\s*renderOrderForLayerAtZ\(\s*0\s*,\s*'BOARD_STRING'\s*\)\s*;/, 'string mesh must use BOARD_STRING');
});
