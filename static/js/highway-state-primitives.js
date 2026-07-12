// highway.js's STATEFUL primitives: the four shared helpers that need per-instance state.
//
// ━━━ hwState IS A PARAMETER, NOT AN IMPORT. THIS IS THE WHOLE DESIGN. ━━━
//
// createHighway() is a FACTORY. The constitution publishes window.createHighway so a plugin can
// build a SECOND highway for its own panel, and highway.js says so itself:
//
//     // R3c: per-instance mutable state in one object, so extracted renderer/ws
//     // modules can close over it as a factory arg without cross-panel sharing.
//
// Import hwState as a module singleton and the two panels silently share one clock, one render
// scale, one string palette — each driving the other. Nothing would throw. The picture would
// just be wrong, in a way no test would catch.
//
// So every function here takes hwState as its FIRST ARGUMENT. It reads a little worse at the
// call site and it is the only correct shape.
//
// (This is the exact opposite of the app.js carve, where player-state.js and library-state.js
// ARE module singletons — correctly, because there is exactly one app. Same epic, same
// language, opposite answer, decided entirely by whether the thing is a factory.)
//
// The PURE primitives — project, roundRect, and the label helpers — need none of this and live
// in ./highway-geometry.js.
// No imports. These four need nothing but the hwState they are handed and their arguments.

export function fretX(hwState, fret, scale, w) {
    const hw = w * 0.52 * scale;
    const margin = hw * 0.06;
    const usable = hw * 2 - 2 * margin;
    const t = fret / Math.max(1, hwState.displayMaxFret);
    return w / 2 - hw + margin + t * usable;
}

export function fillTextReadable(hwState, text, x, y) {
    // ctx may be null when the 2D context was never acquired
    // (canvas already locked to WebGL). No-op in that case —
    // alternatives would be throwing, which breaks plugin hooks
    // that call this after a context-type mismatch.
    if (!hwState.canvas || !hwState.ctx) return;
    const W = hwState.canvas.width;
    if (!hwState._lefty) {
        hwState.ctx.fillText(text, x, y);
        return;
    }
    hwState.ctx.save();
    hwState.ctx.setTransform(1, 0, 0, 1, 0, 0);
    hwState.ctx.fillText(text, W - x, y);
    hwState.ctx.restore();
}

// ── Per-note judgment state (feedBack#254) ──────────────────────────
// Resolves the registered provider for one chart note. Returns null
// when no provider is set, the provider throws, it reports nothing,
// or the reported alpha is non-positive. Otherwise a normalized
// { state: 'hit'|'active'|'miss', alpha: 0..1, color: string|null }.
// 'hit' and 'active' are both "lit" — renderers may treat them the
// same; the distinction (struck note vs currently-held sustain) is
// there for renderers that want it. The provider owns all timing /
// fade — `alpha` is whatever intensity it wants right now.
export function _noteState(hwState, note, chartTime) {
    if (!hwState._noteStateProvider) return null;
    let raw;
    try { raw = hwState._noteStateProvider(note, chartTime); } catch (e) { return null; }
    if (!raw) return null;
    const state = typeof raw === 'string' ? raw : raw.state;
    if (state !== 'hit' && state !== 'active' && state !== 'miss') return null;
    const alpha = (raw && typeof raw === 'object' && Number.isFinite(raw.alpha))
        ? Math.max(0, Math.min(1, raw.alpha))
        : 1;
    if (alpha <= 0) return null;
    const color = (raw && typeof raw === 'object' && typeof raw.color === 'string') ? raw.color : null;
    // Pass through the provider's `live` flag: note_detect tags its
    // ring-tracking 'active' responses with live:true so a renderer can
    // treat them as authoritative (extinguish on mute, relight on
    // re-strike) instead of latching them for the whole chart sustain.
    // Renderers that don't care simply ignore it.
    const live = (raw && typeof raw === 'object' && raw.live === true);
    return { state, alpha, color, live };
}

// Paints the judgment effect on top of an already-drawn gem at
// (cx,cy) with half-extent `r`. `ns` is the normalized state from
// _noteState (or null → no-op). A miss → faint red wash. A correct
// hit / held sustain → a "sizzle": throbbing additive halo + a
// flickering white-hot core + crackling spark lines re-randomised
// each frame + (for a fresh struck note that's fading) an expanding
// shockwave ring. Intensity scales with `ns.alpha`, so a struck
// note flares and dies while a held sustain crackles continuously.
// Caller draws the gem normally first, then calls this BEFORE any
// glyph so a readable fret number can land on top.
export function _paintGemGlow(hwState, cx, cy, r, stringIdx, ns) {
    if (!ns || !hwState.ctx) return;
    hwState.ctx.save();
    if (ns.state === 'miss') {
        hwState.ctx.globalAlpha = 0.4 * ns.alpha;
        hwState.ctx.fillStyle = '#ff2828';
        hwState.ctx.beginPath();
        hwState.ctx.arc(cx, cy, r * 1.05, 0, Math.PI * 2);
        hwState.ctx.fill();
        hwState.ctx.restore();
        return;
    }
    const col = ns.color || hwState.STRING_BRIGHT[stringIdx] || '#ffffff';
    const a = ns.alpha;
    const nowMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    hwState.ctx.lineCap = 'round';

    // Expanding shockwave — only on a fresh struck-and-fading hit
    // (alpha decays 1→0). 'active' (held sustain, alpha pinned 1) skips it.
    if (ns.state === 'hit' && a < 1) {
        const prog = 1 - a;                       // 0 at strike → 1 at fade-out
        hwState.ctx.globalCompositeOperation = 'lighter';
        hwState.ctx.globalAlpha = a * 0.85;
        hwState.ctx.strokeStyle = col;
        hwState.ctx.lineWidth = Math.max(1.5, r * 0.26 * a);
        hwState.ctx.beginPath();
        hwState.ctx.arc(cx, cy, r * (1.0 + prog * 2.7), 0, Math.PI * 2);
        hwState.ctx.stroke();
    }

    // Throbbing halo (≈9 Hz wobble).
    const pulse = 0.8 + 0.2 * Math.sin(nowMs / 18);
    const haloR = r * 2.0 * pulse;
    hwState.ctx.globalCompositeOperation = 'lighter';
    hwState.ctx.globalAlpha = a;
    const g = hwState.ctx.createRadialGradient(cx, cy, 0, cx, cy, haloR);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.30, col);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    hwState.ctx.fillStyle = g;
    hwState.ctx.beginPath();
    hwState.ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
    hwState.ctx.fill();

    // Crackle — short bright spark lines flicking out from the gem,
    // re-randomised every frame so it shimmers.
    const sparkCount = 6;
    for (let i = 0; i < sparkCount; i++) {
        if (Math.random() > 0.55 * a + 0.2) continue;     // intermittent
        const ang = Math.random() * Math.PI * 2;
        const inR = r * 0.45;
        const len = r * (0.7 + Math.random() * 1.6) * (0.5 + 0.5 * a);
        hwState.ctx.globalAlpha = a * (0.45 + Math.random() * 0.55);
        hwState.ctx.strokeStyle = Math.random() < 0.5 ? '#ffffff' : col;
        hwState.ctx.lineWidth = Math.max(1, r * (0.08 + Math.random() * 0.08));
        hwState.ctx.beginPath();
        hwState.ctx.moveTo(cx + Math.cos(ang) * inR, cy + Math.sin(ang) * inR);
        hwState.ctx.lineTo(cx + Math.cos(ang) * (inR + len), cy + Math.sin(ang) * (inR + len));
        hwState.ctx.stroke();
    }

    // Flickering white-hot core.
    hwState.ctx.globalCompositeOperation = 'lighter';
    hwState.ctx.globalAlpha = a * (0.55 + Math.random() * 0.45);
    hwState.ctx.fillStyle = '#ffffff';
    hwState.ctx.beginPath();
    hwState.ctx.arc(cx, cy, r * (0.30 + Math.random() * 0.14), 0, Math.PI * 2);
    hwState.ctx.fill();

    // Crisp bright rim.
    hwState.ctx.globalCompositeOperation = 'source-over';
    hwState.ctx.globalAlpha = a;
    hwState.ctx.strokeStyle = col;
    hwState.ctx.lineWidth = Math.max(2, r * 0.2);
    hwState.ctx.beginPath();
    hwState.ctx.arc(cx, cy, r * 0.95, 0, Math.PI * 2);
    hwState.ctx.stroke();

    hwState.ctx.restore();
}
