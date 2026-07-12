// highway.js's PURE geometry + label primitives.
//
// Every function here is a pure function of its arguments. None of them touches hwState, and
// none closes over the canvas context — roundRect() already took `ctx` explicitly, and the
// rest need nothing but numbers. project() reads only the module-level constants from
// ./highway-constants.js.
//
// THAT PURITY IS WHY THIS SLICE IS SAFE, and why it is the one to do first. createHighway() is
// a FACTORY — a plugin can build a second highway for its own panel — so anything holding
// per-instance state (hwState) must be passed it as an argument rather than importing it, or
// two panels silently share one clock and palette. These six hold no state at all, so they
// move VERBATIM: not one call site changes.
//
// The primitives that DO need hwState (fretX, fillTextReadable, _noteState, _paintGemGlow)
// are deliberately left behind. They need an explicit hwState parameter threaded through 53
// call sites, which is a real change and belongs in its own commit, not smuggled in beside a
// provably-identical move.
import { VISIBLE_SECONDS, Z_CAM, Z_MAX } from './highway-constants.js';

// ── Projection ───────────────────────────────────────────────────────
export function project(tOffset) {
    if (tOffset > VISIBLE_SECONDS || tOffset < -0.05) return null;
    if (tOffset < 0) return { y: 0.82 + Math.abs(tOffset) * 0.3, scale: 1.0 };

    const z = tOffset * (Z_MAX / VISIBLE_SECONDS);
    const denom = z + Z_CAM;
    if (denom < 0.01) return null;
    const scale = Z_CAM / denom;
    const y = 0.82 + (0.08 - 0.82) * (1.0 - scale);
    return { y, scale };
}

export function bnvNormalizedPoints(bnv, sus) {
    if (!Array.isArray(bnv) || bnv.length === 0) return [];
    // Map each point's time over the NOTE's span [0, sus] so it sits at its
    // real fraction of the note (a bend that completes before the note ends
    // draws short of the glyph's right edge). Fall back to the curve's own
    // t-range only when the note has no usable sustain.
    if (Number.isFinite(sus) && sus > 0) {
        return bnv.map(p => ({ x: Math.min(Math.max(p.t / sus, 0), 1), v: p.v }));
    }
    const t0 = bnv[0].t;
    const span = bnv[bnv.length - 1].t - t0;
    return bnv.map(p => ({ x: span > 0 ? (p.t - t0) / span : 0, v: p.v }));
}

export function teachingFingerLabel(fg) {
    if (!Number.isInteger(fg) || fg < 0 || fg > 4) return '';
    return fg === 0 ? 'T' : String(fg);
}

export function teachingDegreeLabel(sd) {
    if (!Number.isInteger(sd) || sd < 0 || sd > 11) return '';
    return String(sd);
}

export function chordHarmonyLabels(fn, voicing, caged, guideTones) {
    const rn = (fn && typeof fn.rn === 'string') ? fn.rn.trim() : '';
    const vc = (typeof voicing === 'string') ? voicing.trim() : '';
    const cg = (typeof caged === 'string' && /^[CAGED]$/.test(caged.trim()))
        ? 'CAGED: ' + caged.trim() : '';
    const gt = Array.isArray(guideTones)
        ? guideTones.filter(n => Number.isInteger(n) && n >= 0 && n <= 11) : [];
    return { rn, voicing: vc, caged: cg, guideTones: gt.length ? 'gt ' + gt.join(',') : '' };
}

export function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}
