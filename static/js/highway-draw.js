// The 2D highway's DRAWING LAYER: notes, sustains, chords, strum groups, unison bends and
// lyrics — everything the default renderer paints on the canvas each frame.
//
// hwState is a PARAMETER on every function that needs it, never an import. createHighway() is a
// FACTORY (the constitution publishes window.createHighway so a plugin can build a second
// highway for its own panel), so a module-level singleton would let two panels share one clock,
// one palette, one set of caches — silently, with nothing throwing.
//
// THREE PER-INSTANCE CACHES CAME WITH THIS SLICE, and they are the reason it needed care:
//
//     _frameMismatchWarned  a warn-once Set of chord ids     (feedBack#88)
//     _chordRenderInfo      a WeakMap of chord -> chain info
//     _lyricMeasureCache    Map<fontSize, Map<text, width>>
//
// All three are MUTATED. Left at module scope they would be shared across panels — one
// highway's lyric widths and chord chains stomping another's. They now live on hwState, which
// is exactly what hwState is for.
//
// The shimmer LUT went the OTHER way, to module scope in ./highway-geometry.js: it is a
// deterministic xorshift table, identical for every instance, so sharing it is not merely safe
// but better — built once for the page rather than once per panel. Mutability, not location,
// is what decides.
import {
    _paintGemGlow, _noteState, fillTextReadable, fretX,
} from './highway-state-primitives.js';
import {
    _shimmerNoise, bnvNormalizedPoints, chordHarmonyLabels, project, roundRect,
    teachingDegreeLabel, teachingFingerLabel,
} from './highway-geometry.js';
import {
    BG, CHAIN_GAP_THRESHOLD, CHAIN_RENDER_FULL_MAX, CHORD_FRAME_FRETS, MUTE_BOX_BAR,
    MUTE_BOX_STROKE, REPEAT_BOX_BAR, REPEAT_BOX_FILL, VISIBLE_SECONDS,
    FRETLINE_TARGET_OFFSET, FRETLINE_WINDOW_AFTER, FRETLINE_WINDOW_BEFORE,
    _LYRIC_MEASURE_INNER_MAX, _LYRIC_MEASURE_OUTER_MAX,
} from './highway-constants.js';

export function _measureLyricText(hwState, c, fontSize, text) {
    let inner = hwState._lyricMeasureCache.get(fontSize);
    if (inner === undefined) {
        if (hwState._lyricMeasureCache.size >= _LYRIC_MEASURE_OUTER_MAX) hwState._lyricMeasureCache.clear();
        inner = new Map();
        hwState._lyricMeasureCache.set(fontSize, inner);
    }
    let w = inner.get(text);
    if (w === undefined) {
        if (inner.size >= _LYRIC_MEASURE_INNER_MAX) inner.clear();
        w = c.measureText(text).width;
        inner.set(text, w);
    }
    return w;
}

export function strumGroupBuckets(items) {
    if (!Array.isArray(items)) return [];
    const order = [];
    const byKey = new Map();
    for (const it of items) {
        const ch = it && Number.isInteger(it.ch) ? it.ch : -1;
        if (ch < 0) continue;
        if (!byKey.has(ch)) { byKey.set(ch, []); order.push(ch); }
        byKey.get(ch).push(it);
    }
    return order.map(k => byKey.get(k)).filter(g => g.length >= 2);
}

export function drawNote(hwState, W, H, x, y, scale, string, fret, opts, ns) {
    // ns (feedBack#254): normalized judgment state from _noteState,
    // or null/undefined. `lit` means render the gem in the bright
    // string colour with an additive halo; a miss gets a faint red
    // wash instead. ns absent → byte-for-byte the original render.
    const lit = !!(ns && ns.state !== 'miss');
    const isHarmonic = opts?.hm || opts?.hp || false;
    const isPinchHarmonic = opts?.hp || false;
    const isChord = opts?.chord || false;
    const bend = opts?.bn || 0;
    const slide = opts?.sl ?? -1;  // pitched slide-to fret (-1 = none; 0 = slide to open)
    const slu = opts?.slu ?? -1;   // unpitched slide-to fret (-1 = none)
    const hammerOn = opts?.ho || false;
    const pullOff = opts?.po || false;
    const tap = opts?.tp || false;
    const palmMute = opts?.pm || false;
    const tremolo = opts?.tr || false;
    const accent = opts?.ac || false;
    const sz = Math.max(12, 80 * scale * (H / 900));
    const half = sz / 2;
    // When lit, bump the body one step brighter and the backing-glow
    // one step up from STRING_DIM, so even shapes that don't get the
    // _paintGemGlow halo (the open-string bar) read as "lit".
    const color = lit ? (ns.color || hwState.STRING_BRIGHT[string] || hwState.STRING_COLORS[string] || '#888') : (hwState.STRING_COLORS[string] || '#888');
    const dark = lit ? (hwState.STRING_COLORS[string] || '#666') : (hwState.STRING_DIM[string] || '#222');

    if (sz < 6) {
        hwState.ctx.fillStyle = color;
        hwState.ctx.beginPath();
        hwState.ctx.arc(x, y, 2, 0, Math.PI * 2);
        hwState.ctx.fill();
        return;
    }

    // Open string: wide bar spanning the highway (only for standalone notes)
    if (fret === 0 && !isChord) {
        const hw = W * 0.26 * scale;
        const barH = Math.max(6, sz * 0.45);
        // Shadow
        hwState.ctx.fillStyle = dark;
        roundRect(hwState.ctx, W/2 - hw - 1, y - barH/2 - 1, hw * 2 + 2, barH + 2, 3);
        hwState.ctx.fill();
        // Body
        hwState.ctx.fillStyle = color;
        roundRect(hwState.ctx, W/2 - hw, y - barH/2, hw * 2, barH, 2);
        hwState.ctx.fill();
        // Judgment glow (feedBack#254) — central halo on the bar.
        // _paintGemGlow takes a half-extent; barH is the full bar height.
        _paintGemGlow(hwState, W/2, y, barH * 0.5, string, ns);
        // "0" label
        const fontSize = Math.max(8, sz * 0.5) | 0;
        hwState.ctx.fillStyle = '#fff';
        hwState.ctx.font = `bold ${fontSize}px sans-serif`;
        hwState.ctx.textAlign = 'center';
        hwState.ctx.textBaseline = 'middle';
        fillTextReadable(hwState, '0', W/2, y);

        // Technique labels on open strings — PM, H/P/T, tremolo, and
        // accent markers are all meaningful on fret 0. Bend and slide
        // are omitted because they reference a fret position that the
        // centered bar doesn't visually convey. Matches the sz<14 gate
        // the fretted path uses so labels don't render on tiny bars.
        // Fixes #21.
        if (sz >= 14) {
            // H / P / T above
            if (hammerOn || pullOff || tap) {
                const label = tap ? 'T' : (hammerOn ? 'H' : 'P');
                hwState.ctx.fillStyle = '#fff';
                hwState.ctx.font = `bold ${Math.max(9, sz * 0.3) | 0}px sans-serif`;
                hwState.ctx.textAlign = 'center';
                hwState.ctx.textBaseline = 'bottom';
                fillTextReadable(hwState, label, W/2, y - barH/2 - 4);
            }
            // PM below
            if (palmMute) {
                hwState.ctx.fillStyle = '#aaa';
                hwState.ctx.font = `bold ${Math.max(8, sz * 0.25) | 0}px sans-serif`;
                hwState.ctx.textAlign = 'center';
                hwState.ctx.textBaseline = 'top';
                fillTextReadable(hwState, 'PM', W/2, y + barH/2 + 2);
            }
            // Tremolo (wavy line above)
            if (tremolo) {
                const ty = y - barH/2 - 6;
                hwState.ctx.strokeStyle = '#ff0';
                hwState.ctx.lineWidth = 1.5;
                hwState.ctx.beginPath();
                for (let i = -3; i <= 3; i++) {
                    const wx = W/2 + i * sz * 0.08;
                    const wy = ty + Math.sin(i * 2) * 3;
                    if (i === -3) hwState.ctx.moveTo(wx, wy);
                    else hwState.ctx.lineTo(wx, wy);
                }
                hwState.ctx.stroke();
            }
            // Accent caret above
            if (accent) {
                const ay2 = y - barH/2 - 4;
                hwState.ctx.strokeStyle = '#fff';
                hwState.ctx.lineWidth = 2;
                hwState.ctx.beginPath();
                hwState.ctx.moveTo(W/2 - sz * 0.2, ay2 + 3);
                hwState.ctx.lineTo(W/2, ay2 - 2);
                hwState.ctx.lineTo(W/2 + sz * 0.2, ay2 + 3);
                hwState.ctx.stroke();
            }
        }
        return;
    }

    if (isHarmonic) {
        // Diamond shape for harmonics
        const dh = half * 1.15;
        // Glow
        hwState.ctx.fillStyle = dark;
        hwState.ctx.beginPath();
        hwState.ctx.moveTo(x, y - dh - 3); hwState.ctx.lineTo(x + half + 3, y);
        hwState.ctx.lineTo(x, y + dh + 3); hwState.ctx.lineTo(x - half - 3, y);
        hwState.ctx.closePath(); hwState.ctx.fill();
        // Body
        hwState.ctx.fillStyle = color;
        hwState.ctx.beginPath();
        hwState.ctx.moveTo(x, y - dh); hwState.ctx.lineTo(x + half, y);
        hwState.ctx.lineTo(x, y + dh); hwState.ctx.lineTo(x - half, y);
        hwState.ctx.closePath(); hwState.ctx.fill();
        // Bright outline
        hwState.ctx.strokeStyle = hwState.STRING_BRIGHT[string] || '#fff';
        hwState.ctx.lineWidth = 2;
        hwState.ctx.beginPath();
        hwState.ctx.moveTo(x, y - dh); hwState.ctx.lineTo(x + half, y);
        hwState.ctx.lineTo(x, y + dh); hwState.ctx.lineTo(x - half, y);
        hwState.ctx.closePath(); hwState.ctx.stroke();
        // PH label for pinch harmonics
        if (isPinchHarmonic && sz >= 14) {
            hwState.ctx.fillStyle = '#ff0';
            hwState.ctx.font = `bold ${Math.max(8, sz * 0.25) | 0}px sans-serif`;
            hwState.ctx.textAlign = 'center';
            hwState.ctx.textBaseline = 'top';
            fillTextReadable(hwState, 'PH', x, y + dh + 2);
        }
    } else {
        // Glow
        hwState.ctx.fillStyle = dark;
        roundRect(hwState.ctx, x - half - 4, y - half - 4, sz + 8, sz + 8, sz / 3);
        hwState.ctx.fill();
        // Body
        hwState.ctx.fillStyle = color;
        roundRect(hwState.ctx, x - half, y - half, sz, sz, sz / 5);
        hwState.ctx.fill();
    }

    // Judgment glow (feedBack#254) — additive halo for a correct
    // hit / held sustain, faint red wash for a miss. Drawn before
    // the fret number so the number stays legible on top.
    _paintGemGlow(hwState, x, y, isHarmonic ? half * 1.2 : half, string, ns);

    // Fret number
    const fontSize = Math.max(10, sz * 0.5) | 0;
    hwState.ctx.fillStyle = '#fff';
    hwState.ctx.font = `bold ${fontSize}px sans-serif`;
    hwState.ctx.textAlign = 'center';
    hwState.ctx.textBaseline = 'middle';
    fillTextReadable(hwState, String(fret), x, y);

    // Bend notation
    if (bend && bend > 0 && sz >= 12) {
        const lw = Math.max(2, sz / 10);
        const ay = y - half - 4;
        // px above the gem for a bend of `v` semitones (shared by the
        // curve contour and the scalar-arrow fallback).
        const hOf = (v) => sz * 0.55 * Math.min(Math.max(v, 0), 2);
        const bnv = Array.isArray(opts?.bnv) ? opts.bnv : null;

        hwState.ctx.strokeStyle = '#fff';
        hwState.ctx.lineWidth = lw;

        let labelTopY;  // y of the highest drawn point, for the label
        if (bnv && bnv.length >= 2) {
            // Bend curve (§6.2.1): trace the real shape as a contour above
            // the gem (round-trip rises then falls, pre-bend starts high,
            // release descends, …) — `bt` is implicit in the point shape.
            const pts = bnvNormalizedPoints(bnv, opts?.sus);
            const gw = sz * 0.6;
            const x0 = x - gw / 2;
            hwState.ctx.beginPath();
            pts.forEach((pt, i) => {
                const px = x0 + pt.x * gw;
                const py = ay - hOf(pt.v);
                if (i === 0) hwState.ctx.moveTo(px, py); else hwState.ctx.lineTo(px, py);
            });
            hwState.ctx.stroke();
            // Arrowhead only when the gesture ends rising (plain bend /
            // pre-bend); round-trip and release finish heading down.
            const a = pts[pts.length - 2], b = pts[pts.length - 1];
            if (b.v > a.v + 0.05) {
                const tipX = x0 + b.x * gw, tipY = ay - hOf(b.v);
                hwState.ctx.beginPath();
                hwState.ctx.moveTo(tipX - sz * 0.1, tipY + sz * 0.12);
                hwState.ctx.lineTo(tipX, tipY);
                hwState.ctx.lineTo(tipX + sz * 0.1, tipY + sz * 0.12);
                hwState.ctx.stroke();
            }
            labelTopY = ay - hOf(Math.max(...pts.map(p => p.v)));
        } else {
            // Fallback: single curved arrow up to the scalar peak.
            const arrowH = hOf(bend);  // taller for bigger bends
            const tipY = ay - arrowH;
            hwState.ctx.beginPath();
            hwState.ctx.moveTo(x, ay);
            hwState.ctx.quadraticCurveTo(x + sz * 0.2, ay - arrowH * 0.5, x, tipY);
            hwState.ctx.stroke();
            hwState.ctx.beginPath();
            hwState.ctx.moveTo(x - sz * 0.12, tipY + sz * 0.12);
            hwState.ctx.lineTo(x, tipY);
            hwState.ctx.lineTo(x + sz * 0.12, tipY + sz * 0.12);
            hwState.ctx.stroke();
            labelTopY = tipY;
        }

        // Bend label: peak magnitude — "full", "1/2", "1 1/2", "2"
        let label;
        if (bend === 0.5) label = '½';
        else if (bend === 1) label = 'full';
        else if (bend === 1.5) label = '1½';
        else if (bend === 2) label = '2';
        else label = bend.toFixed(1);

        hwState.ctx.fillStyle = '#fff';
        hwState.ctx.font = `bold ${Math.max(9, sz * 0.28) | 0}px sans-serif`;
        hwState.ctx.textAlign = 'center';
        hwState.ctx.textBaseline = 'bottom';
        fillTextReadable(hwState, label, x, labelTopY - 2);
    }

    if (sz < 14) return;  // Skip small technique labels

    // Teaching marks (§6.2.2) — display only, never grading. The fret-hand
    // finger (fg) renders by default as a small numeral hugging the gem's
    // right edge (T = thumb, 1..4), hideable via the finger-hints toggle; the
    // scale degree (sd) is opt-in and sits on the left edge so the two never
    // collide with the centred fret number.
    const fgLabel = hwState._showFingerHints ? teachingFingerLabel(opts?.fg) : '';
    if (fgLabel) {
        hwState.ctx.fillStyle = '#7fd1ff';
        hwState.ctx.font = `bold ${Math.max(8, sz * 0.26) | 0}px sans-serif`;
        hwState.ctx.textAlign = 'left';
        hwState.ctx.textBaseline = 'middle';
        fillTextReadable(hwState, fgLabel, x + half + 2, y + half * 0.5);
    }
    if (hwState._showTeachingMarks) {
        const sdLabel = teachingDegreeLabel(opts?.sd);
        if (sdLabel) {
            hwState.ctx.fillStyle = '#ffcc66';
            hwState.ctx.font = `bold ${Math.max(8, sz * 0.26) | 0}px sans-serif`;
            hwState.ctx.textAlign = 'right';
            hwState.ctx.textBaseline = 'middle';
            fillTextReadable(hwState, sdLabel, x - half - 2, y + half * 0.5);
        }
    }

    // Slide indicator (diagonal arrow). Pitched (sl) draws a solid arrow to
    // the target fret; unpitched (slu) draws a dashed diagonal with no
    // arrowhead (no definite target pitch). The two are mutually exclusive
    // in the data; the 3D highway makes the same pitched/unpitched split.
    if (slide >= 0 || slu >= 0) {
        const pitched = slide >= 0;
        const target = pitched ? slide : slu;
        const dir = target > fret ? -1 : 1;  // up or down the neck; mirror handles lefty
        hwState.ctx.strokeStyle = '#fff';
        hwState.ctx.lineWidth = Math.max(2, sz / 10);
        if (!pitched) hwState.ctx.setLineDash([Math.max(2, sz / 8), Math.max(2, sz / 8)]);
        hwState.ctx.beginPath();
        hwState.ctx.moveTo(x - sz * 0.3, y + dir * sz * 0.3);
        hwState.ctx.lineTo(x + sz * 0.3, y - dir * sz * 0.3);
        hwState.ctx.stroke();
        if (!pitched) hwState.ctx.setLineDash([]);
        // Arrowhead only for a pitched slide (definite target pitch).
        if (pitched) {
            hwState.ctx.beginPath();
            hwState.ctx.moveTo(x + sz * 0.3, y - dir * sz * 0.3);
            hwState.ctx.lineTo(x + sz * 0.15, y - dir * sz * 0.15);
            hwState.ctx.stroke();
        }
    }

    // H/P/T label above note
    if (hammerOn || pullOff || tap) {
        const label = tap ? 'T' : (hammerOn ? 'H' : 'P');
        const ly = y - half - (bend > 0 ? sz * 0.6 : 4);
        hwState.ctx.fillStyle = '#fff';
        hwState.ctx.font = `bold ${Math.max(9, sz * 0.3) | 0}px sans-serif`;
        hwState.ctx.textAlign = 'center';
        hwState.ctx.textBaseline = 'bottom';
        fillTextReadable(hwState, label, x, ly);
    }

    // Palm mute (PM below note)
    if (palmMute) {
        hwState.ctx.fillStyle = '#aaa';
        hwState.ctx.font = `bold ${Math.max(8, sz * 0.25) | 0}px sans-serif`;
        hwState.ctx.textAlign = 'center';
        hwState.ctx.textBaseline = 'top';
        fillTextReadable(hwState, 'PM', x, y + half + 2);
    }

    // Tremolo (wavy line above)
    if (tremolo) {
        const ty = y - half - (bend > 0 ? sz * 0.7 : 6);
        hwState.ctx.strokeStyle = '#ff0';
        hwState.ctx.lineWidth = 1.5;
        hwState.ctx.beginPath();
        for (let i = -3; i <= 3; i++) {
            const wx = x + i * sz * 0.08;
            const wy = ty + Math.sin(i * 2) * 3;
            if (i === -3) hwState.ctx.moveTo(wx, wy);
            else hwState.ctx.lineTo(wx, wy);
        }
        hwState.ctx.stroke();
    }

    // Accent (> marker)
    if (accent) {
        const ay2 = y - half - 4;
        hwState.ctx.strokeStyle = '#fff';
        hwState.ctx.lineWidth = 2;
        hwState.ctx.beginPath();
        hwState.ctx.moveTo(x - sz * 0.2, ay2 + 3);
        hwState.ctx.lineTo(x, ay2 - 2);
        hwState.ctx.lineTo(x + sz * 0.2, ay2 + 3);
        hwState.ctx.stroke();
    }
}

export function drawSustains(hwState, W, H) {
    // Same master-difficulty fallback as drawNotes/drawChords —
    // without this, sustain bars for filtered-out notes would
    // still render, leaving orphan rectangles where no note head
    // is drawn. An active chart transform substitutes its staged view.
    const src = hwState._xfNotes !== null ? hwState._xfNotes
        : hwState._filteredNotes !== null ? hwState._filteredNotes : hwState.notes;
    for (const n of src) {
        if (n.sus <= 0.01) continue;
        const end = n.t + n.sus;
        if (end < hwState.currentTime || n.t > hwState.currentTime + VISIBLE_SECONDS) continue;

        const t0 = Math.max(n.t - hwState.currentTime, 0);
        const t1 = Math.min(end - hwState.currentTime, VISIBLE_SECONDS);
        if (t0 >= t1) continue;

        const p0 = project(t0), p1 = project(t1);
        if (!p0 || !p1) continue;

        const x0 = fretX(hwState, n.f, p0.scale, W);
        const x1 = fretX(hwState, n.f, p1.scale, W);
        const sw0 = Math.max(2, 6 * p0.scale);
        const sw1 = Math.max(2, 6 * p1.scale);

        // feedBack#254 — a sustain that's currently being held
        // correctly "sizzles" in the bright string colour (glow +
        // flickering brightness + a crackling current down the
        // middle); otherwise the usual dim trail. A miss is left dim
        // (the gem / overlay marks the miss; a red trail would be
        // noisy). Skip the lookup entirely when no provider is set —
        // zero cost in the hot loop for the common case.
        const ns = hwState._noteStateProvider ? _noteState(hwState, n, n.t) : null;
        const litTrail = !!(ns && ns.state !== 'miss');
        const y0 = p0.y * H, y1 = p1.y * H;
        if (litTrail) {
            const a = ns.alpha;
            const col = ns.color || hwState.STRING_BRIGHT[n.s] || hwState.STRING_COLORS[n.s] || '#666';
            // Per-note seed so neighbouring sustains shimmer
            // independently. Math.floor(n.t * 60) is stable across
            // frames yet drifts on song progression; combined with
            // _frameIdx + n.s it gives a non-correlated walk through
            // the LUT, matching the original visual intent
            // (feedBack#254 comment above).
            const seedBase = (hwState._frameIdx + n.s + ((n.t * 60) | 0)) | 0;
            hwState.ctx.save();
            hwState.ctx.fillStyle = col;
            // Shimmering glow WITHOUT ctx.shadowBlur: blur cost scales with
            // the blurred DEVICE-pixel area, and a held sustain's trail can
            // span half the (DPR-scaled) canvas — profiling the "stutters
            // while playing" report put this per-frame blur pass at the top
            // exactly while a sustain is held. Three inflated low-alpha
            // fills of the same quad read as the same soft glow at a flat,
            // area-independent cost. The shimmer LUT still drives the
            // per-frame size/brightness flicker (feedBack#254 intent).
            const glowPx = (8 + 6 * _shimmerNoise(seedBase)) * a;
            const baseA = (0.45 + 0.45 * a) * (0.78 + 0.22 * _shimmerNoise(seedBase + 17));
            const fillTrail = (inflate) => {
                hwState.ctx.beginPath();
                hwState.ctx.moveTo(x0 - sw0 - inflate, y0);
                hwState.ctx.lineTo(x0 + sw0 + inflate, y0);
                hwState.ctx.lineTo(x1 + sw1 + inflate, y1);
                hwState.ctx.lineTo(x1 - sw1 - inflate, y1);
                hwState.ctx.fill();
            };
            hwState.ctx.globalAlpha = baseA * 0.22;
            fillTrail(glowPx);
            hwState.ctx.globalAlpha = baseA * 0.4;
            fillTrail(glowPx * 0.45);
            hwState.ctx.globalAlpha = baseA;
            fillTrail(0);
            // Crackling "current" — a jittery white core line down
            // the trail, re-randomised each frame.
            hwState.ctx.globalCompositeOperation = 'lighter';
            hwState.ctx.globalAlpha = a * (0.55 + 0.45 * _shimmerNoise(seedBase + 31));
            hwState.ctx.strokeStyle = '#ffffff';
            hwState.ctx.lineWidth = Math.max(1.5, sw0 * 0.5);
            hwState.ctx.lineJoin = 'round';
            hwState.ctx.lineCap = 'round';
            hwState.ctx.beginPath();
            const segs = 7;
            for (let k = 0; k <= segs; k++) {
                const f = k / segs;
                const jx = (k === 0 || k === segs) ? 0 : (_shimmerNoise(seedBase + 47 + k) - 0.5) * sw0 * 2.2;
                const xx = x0 + (x1 - x0) * f + jx;
                const yy = y0 + (y1 - y0) * f;
                if (k === 0) hwState.ctx.moveTo(xx, yy); else hwState.ctx.lineTo(xx, yy);
            }
            hwState.ctx.stroke();
            hwState.ctx.restore();
        } else {
            hwState.ctx.fillStyle = hwState.STRING_DIM[n.s] || '#333';
            hwState.ctx.beginPath();
            hwState.ctx.moveTo(x0 - sw0, y0);
            hwState.ctx.lineTo(x0 + sw0, y0);
            hwState.ctx.lineTo(x1 + sw1, y1);
            hwState.ctx.lineTo(x1 - sw1, y1);
            hwState.ctx.fill();
        }
    }
}

export function drawNotes(hwState, W, H) {
    // Master-difficulty filter (feedBack#48): when the source had
    // phrase-level ladder data, render from the mastery-filtered
    // array. _filteredNotes stays null for slider-disabled sources
    // so rendering falls through to the flat notes array unchanged.
    // An active chart transform (_xfNotes) substitutes its staged view.
    const src = hwState._xfNotes !== null ? hwState._xfNotes
        : hwState._filteredNotes !== null ? hwState._filteredNotes : hwState.notes;
    // Binary search for visible range
    const tMin = hwState.currentTime - 0.25;
    const tMax = hwState.currentTime + VISIBLE_SECONDS;
    let lo = bsearch(src, tMin);
    let hi = bsearch(src, tMax);

    // Include sustained notes
    while (lo > 0 && src[lo-1].t + src[lo-1].sus > hwState.currentTime) lo--;

    // Collect drawn positions for unison bend detection
    const drawnNotes = [];

    for (let i = hi - 1; i >= lo; i--) {
        const n = src[i];
        let tOff = n.t - hwState.currentTime;

        // Hold sustained notes at now line
        let p;
        if (tOff < -0.05 && n.sus > 0 && n.t + n.sus > hwState.currentTime) {
            p = { y: 0.82, scale: 1.0 };
        } else {
            p = project(tOff);
        }
        if (!p) continue;

        const x = fretX(hwState, n.f, p.scale, W);
        drawNote(hwState, W, H, x, p.y * H, p.scale, n.s, n.f, n, hwState._noteStateProvider ? _noteState(hwState, n, n.t) : null);
        drawnNotes.push({
            t: n.t, s: n.s, f: n.f, bn: n.bn || 0, x, y: p.y * H, scale: p.scale,
            ch: Number.isInteger(n.ch) ? n.ch : -1,
            pkd: Number.isInteger(n.pkd) ? n.pkd : -1,
        });
    }

    // Draw unison bend connectors
    drawUnisonBends(hwState, W, H, drawnNotes);
    // Strum-group brackets (teaching mark ch, §6.2.2) — opt-in overlay.
    // Scoped to standalone notes (the stream drawNotes renders); chord-note
    // strum groups aren't bracketed (the editor authors ch over single-note
    // selections, and chord notes already read as one simultaneous gesture).
    if (hwState._showTeachingMarks) drawStrumGroups(hwState, W, H, drawnNotes);
}

export function drawStrumGroups(hwState, W, H, drawnNotes) {
    // Teaching mark (§6.2.2): notes sharing a `ch` key >= 0 are one
    // strum/rake gesture. Connect each group's gems with a bracket and a
    // single arrowhead whose direction comes from `pkd` (0 = down-strum,
    // 1 = up-strum). Display only — never grading.
    for (const group of strumGroupBuckets(drawnNotes)) {
        const pts = group.slice().sort((a, b) => a.y - b.y || a.x - b.x);
        const scale = pts[0].scale;
        const sz = Math.max(12, 80 * scale * (H / 900));
        if (sz < 14) continue;
        const pkd = (group.find(p => p.pkd === 0 || p.pkd === 1) || {}).pkd;

        hwState.ctx.save();
        hwState.ctx.strokeStyle = '#c89bff';
        hwState.ctx.lineWidth = Math.max(2, sz / 12);
        hwState.ctx.lineJoin = 'round';
        hwState.ctx.beginPath();
        pts.forEach((p, i) => (i === 0 ? hwState.ctx.moveTo(p.x, p.y) : hwState.ctx.lineTo(p.x, p.y)));
        hwState.ctx.stroke();
        // Arrowhead at the gesture start: down-strum (pkd 0) points toward
        // the last gem, up-strum (pkd 1) toward the first.
        if (pkd === 0 || pkd === 1) {
            const head = pkd === 1 ? pts[0] : pts[pts.length - 1];
            const from = pkd === 1 ? pts[1] : pts[pts.length - 2];
            const dy = Math.sign(head.y - from.y) || 1;
            const a = sz * 0.18;
            hwState.ctx.beginPath();
            hwState.ctx.moveTo(head.x - a, head.y - dy * a);
            hwState.ctx.lineTo(head.x, head.y);
            hwState.ctx.lineTo(head.x + a, head.y - dy * a);
            hwState.ctx.stroke();
        }
        hwState.ctx.restore();
    }
}

export function drawUnisonBends(hwState, W, H, drawnNotes) {
    // Group notes by time (within 0.01s tolerance)
    const groups = [];
    const used = new Set();
    for (let i = 0; i < drawnNotes.length; i++) {
        if (used.has(i)) continue;
        const group = [drawnNotes[i]];
        used.add(i);
        for (let j = i + 1; j < drawnNotes.length; j++) {
            if (used.has(j)) continue;
            if (Math.abs(drawnNotes[j].t - drawnNotes[i].t) < 0.01) {
                group.push(drawnNotes[j]);
                used.add(j);
            }
        }
        if (group.length >= 2) groups.push(group);
    }

    for (const group of groups) {
        // Find pairs: one with bend, one without (or both with different bends)
        const bent = group.filter(n => n.bn > 0);
        const unbent = group.filter(n => n.bn === 0);
        if (bent.length === 0 || unbent.length === 0) continue;

        // Draw connector between each bent-unbent pair
        for (const bn of bent) {
            // Find the closest unbent note by string
            let closest = unbent[0];
            for (const ub of unbent) {
                if (Math.abs(ub.s - bn.s) < Math.abs(closest.s - bn.s)) closest = ub;
            }

            const sz = Math.max(12, 80 * bn.scale * (H / 900));
            if (sz < 14) continue;

            // Draw a curved dashed line connecting bent note to target note
            const x1 = bn.x, y1 = bn.y;
            const x2 = closest.x, y2 = closest.y;
            const midX = (x1 + x2) / 2 + sz * 0.5;
            const midY = (y1 + y2) / 2;

            hwState.ctx.save();
            hwState.ctx.strokeStyle = '#60d0ff';
            hwState.ctx.lineWidth = Math.max(2, sz / 12);
            hwState.ctx.setLineDash([4, 4]);
            hwState.ctx.beginPath();
            hwState.ctx.moveTo(x1, y1);
            hwState.ctx.quadraticCurveTo(midX, midY, x2, y2);
            hwState.ctx.stroke();
            hwState.ctx.setLineDash([]);
            hwState.ctx.restore();

            // "U" label at midpoint
            const labelSz = Math.max(10, sz * 0.3) | 0;
            hwState.ctx.fillStyle = '#60d0ff';
            hwState.ctx.font = `bold ${labelSz}px sans-serif`;
            hwState.ctx.textAlign = 'center';
            hwState.ctx.textBaseline = 'middle';
            const cpX = (x1 + 2 * midX + x2) / 4;
            const cpY = (y1 + 2 * midY + y2) / 4;
            fillTextReadable(hwState, 'U', cpX + sz * 0.3, cpY);
        }
    }
}

export function drawChords(hwState, W, H) {
    // See drawNotes — _filteredChords is null for slider-disabled
    // sources so we fall through to the flat chords array.
    const src = hwState._xfChords !== null ? hwState._xfChords
        : hwState._filteredChords !== null ? hwState._filteredChords : hwState.chords;
    _ensureChordRenderCache(hwState, src);

    const tMin = hwState.currentTime - 0.25;
    const tMax = hwState.currentTime + VISIBLE_SECONDS;
    const lo = bsearchChords(src, tMin);
    const hi = bsearchChords(src, tMax);

    _updateFretLinePreview(hwState, src, lo, hi);
    _drawFretLineChordPreview(hwState, W, H);

    for (let i = hi - 1; i >= lo; i--) {
        const ch = src[i];
        const p = project(ch.t - hwState.currentTime);
        if (!p) continue;

        const info = hwState._chordRenderInfo.get(ch);
        const { isFull, baseFret, sortedNotes: sorted, nonZeroNotes, nonZeroFrets, allMuted, hasMultipleNotes } = info;

        const sz = Math.max(10, 28 * p.scale * (H / 900));
        const spread = sz * 0.85;
        const minSpread = sz + 16 * p.scale;
        const actualSpread = Math.max(spread, minSpread);
        const actualTotalH = actualSpread * Math.max(0, sorted.length - 1);

        const { tmpl, getTemplateFret } = getChordTemplateInfo(ch.id, _effChordTemplates(hwState));
        const hasNonZero = nonZeroNotes.length >= 1;

        const frameLeftFret = baseFret;
        const frameRightFret = baseFret + CHORD_FRAME_FRETS;

        // Frame validation — log once per chord id rather than every frame.
        if (hasNonZero && !hwState._frameMismatchWarned.has(ch.id)) {
            let notesInFrame = true;
            for (let k = 0; k < nonZeroFrets.length; k++) {
                const f = nonZeroFrets[k];
                if (f < frameLeftFret || f > frameRightFret) { notesInFrame = false; break; }
            }
            if (!notesInFrame) {
                hwState._frameMismatchWarned.add(ch.id);
                console.warn('Chord frame mismatch:', ch.id, { frameLeftFret, frameRightFret, nonZeroFrets });
            }
        }

        // X span between fretted notes (excluding open strings) —
        // single pass over cached nonZeroFrets, no spread + Math.min/max.
        let xMin = null, xMax = null;
        if (hasNonZero) {
            xMin = Infinity; xMax = -Infinity;
            for (let k = 0; k < nonZeroFrets.length; k++) {
                const x = fretX(hwState, nonZeroFrets[k], p.scale, W);
                if (x < xMin) xMin = x;
                if (x > xMax) xMax = x;
            }
        }
        if (allMuted) {
            const { boxX, boxW, boxTop, boxH } = _computeChordBox(hwState, p, H, W, sorted, sz, actualSpread, baseFret);

            hwState.ctx.strokeStyle = MUTE_BOX_STROKE;
            hwState.ctx.lineWidth = Math.max(2, sz / 6);
            roundRect(hwState.ctx, boxX, boxTop, boxW, boxH, 2);
            hwState.ctx.stroke();

            hwState.ctx.fillStyle = MUTE_BOX_BAR;
            hwState.ctx.fillRect(boxX, boxTop + 2, boxW, 4);

            // Gray X cross, centered in frame
            const xInset = sz * 0.6;
            const xStartX = boxX + xInset;
            const xEndX = boxX + boxW - xInset;
            hwState.ctx.beginPath();
            hwState.ctx.moveTo(xStartX, boxTop + sz * 0.5);
            hwState.ctx.lineTo(xEndX, boxTop + boxH - sz * 0.5);
            hwState.ctx.moveTo(xEndX, boxTop + sz * 0.5);
            hwState.ctx.lineTo(xStartX, boxTop + boxH - sz * 0.5);
            hwState.ctx.stroke();

            continue;
        }

        // Repeat chord (mid-chain): translucent box + bracket bar.
        if (!isFull) {
            const { boxX, boxW, boxTop, boxH } = _computeChordBox(hwState, p, H, W, sorted, sz, actualSpread, baseFret);

            hwState.ctx.fillStyle = REPEAT_BOX_FILL;
            roundRect(hwState.ctx, boxX, boxTop, boxW, boxH, 2);
            hwState.ctx.fill();

            hwState.ctx.fillStyle = REPEAT_BOX_BAR;
            hwState.ctx.fillRect(boxX, boxTop + 2, boxW, 4);

            continue;
        }

        // First-in-chain (or short chain): full chord rendering.
        // Bracket bar above the notes.
        if (hasNonZero || sorted.length >= 2) {
            const positions = (hasNonZero ? nonZeroNotes : sorted).map((cn, j) => ({
                x: fretX(hwState, cn.f, p.scale, W),
                y: p.y * H - actualTotalH / 2 + j * actualSpread,
            }));
            const barY = positions[0].y - sz * 0.7;
            const barLeft = hasNonZero ? xMin : fretX(hwState, frameLeftFret, p.scale, W);
            const barRight = hasNonZero ? xMax : fretX(hwState, frameRightFret, p.scale, W);

            hwState.ctx.fillStyle = REPEAT_BOX_BAR;
            hwState.ctx.lineWidth = Math.max(3, sz / 4);
            roundRect(hwState.ctx, barLeft - 2, barY - 2, barRight - barLeft + 4, 4, 2);
            hwState.ctx.fill();
            for (const pos of positions) {
                hwState.ctx.fillRect(pos.x - 2, barY, 4, pos.y - sz / 2 - barY);
            }
        }

        // Chord name label
        if (!ch.hd && p.scale > 0.15 && tmpl && tmpl.name) {
            const labelY = hasNonZero
                ? (p.y * H - actualTotalH / 2 - sz * 0.7 - sz * 0.4)
                : (p.y * H - sz * 0.8);
            const labelX = hasNonZero
                ? (xMin + xMax) / 2
                : (sorted.length >= 2
                    ? (fretX(hwState, frameLeftFret, p.scale, W) + fretX(hwState, frameRightFret, p.scale, W)) / 2
                    : fretX(hwState, sorted[0].f, p.scale, W));
            hwState.ctx.fillStyle = '#fff';
            hwState.ctx.font = `bold ${Math.max(14, sz * 0.45) | 0}px sans-serif`;
            hwState.ctx.textAlign = 'center';
            hwState.ctx.textBaseline = 'bottom';
            fillTextReadable(hwState, tmpl.name, labelX, labelY);
        }

        // Harmony annotations (§6.3.1 / §6.6) — the chord's function
        // (fn.rn Roman numeral) and template voicing, stacked above the
        // chord name. Gated behind the teaching-marks opt-in (same overlay
        // class as sd/ch) so they don't clutter the default highway.
        // Display only — never grading.
        if (hwState._showTeachingMarks && !ch.hd && p.scale > 0.15 && sorted.length > 0) {
            const { rn, voicing, caged, guideTones } = chordHarmonyLabels(
                ch.fn, tmpl && tmpl.voicing, tmpl && tmpl.caged, tmpl && tmpl.guideTones);
            if (rn || voicing || caged || guideTones) {
                const hx = hasNonZero
                    ? (xMin + xMax) / 2
                    : (sorted.length >= 2
                        ? (fretX(hwState, frameLeftFret, p.scale, W) + fretX(hwState, frameRightFret, p.scale, W)) / 2
                        : fretX(hwState, sorted[0].f, p.scale, W));
                // Baseline = just above where the chord name sits.
                const nameY = hasNonZero
                    ? (p.y * H - actualTotalH / 2 - sz * 0.7 - sz * 0.4)
                    : (p.y * H - sz * 0.8);
                hwState.ctx.font = `bold ${Math.max(10, sz * 0.32) | 0}px sans-serif`;
                hwState.ctx.textAlign = 'center';
                hwState.ctx.textBaseline = 'bottom';
                let stackY = nameY - sz * 0.5;
                if (rn) {
                    hwState.ctx.fillStyle = '#ffcc66';   // matches the sd teaching color
                    fillTextReadable(hwState, rn, hx, stackY);
                    stackY -= sz * 0.45;
                }
                if (voicing) {
                    hwState.ctx.fillStyle = '#7fd1ff';   // matches the fg teaching color
                    fillTextReadable(hwState, voicing, hx, stackY);
                    stackY -= sz * 0.45;
                }
                if (caged) {
                    hwState.ctx.fillStyle = '#a0ffa0';   // CAGED shape teaching color
                    fillTextReadable(hwState, caged, hx, stackY);
                    stackY -= sz * 0.45;
                }
                if (guideTones) {
                    hwState.ctx.fillStyle = '#d0a0ff';   // guide-tone teaching color
                    fillTextReadable(hwState, guideTones, hx, stackY);
                }
            }
        }

        // Notes — wide colored bar for open strings inside a chord,
        // normal note glyph otherwise.
        // Classify into bent / unbent arrays inline (was: post-filter
        // chordPositions twice into bent/unbent).
        const bent = [];
        const unbent = [];

        for (let j = 0; j < sorted.length; j++) {
            const cn = sorted[j];
            const x = fretX(hwState, cn.f, p.scale, W);
            const ny = p.y * H - actualTotalH / 2 + j * actualSpread;
            // feedBack#254 — per-string judgment, keyed by the
            // chord's chart time (matches how note_detect stores it).
            const cnNs = hwState._noteStateProvider ? _noteState(hwState, cn, ch.t) : null;

            // Open-string-in-chord wide bar — only when the note has no
            // technique flags. Otherwise fall back to drawNote so PM /
            // H / P / T / tremolo / accent labels still render (drawNote
            // is the only path that emits those labels).
            if (getTemplateFret(cn) === 0 && hasMultipleNotes && !_noteHasTechniqueFlags(cn)) {
                const litBar = !!(cnNs && cnNs.state !== 'miss');
                const color = litBar ? (cnNs.color || hwState.STRING_BRIGHT[cn.s] || hwState.STRING_COLORS[cn.s] || '#888') : (hwState.STRING_COLORS[cn.s] || '#888');
                const dark = litBar ? (hwState.STRING_COLORS[cn.s] || '#666') : (hwState.STRING_DIM[cn.s] || '#222');
                const barH = sz;
                const barLeft = fretX(hwState, frameLeftFret, p.scale, W);
                const barRight = fretX(hwState, frameRightFret, p.scale, W);
                hwState.ctx.fillStyle = dark;
                roundRect(hwState.ctx, barLeft - 1, ny - barH / 2 - 1, barRight - barLeft + 2, barH + 2, 3);
                hwState.ctx.fill();
                hwState.ctx.fillStyle = color;
                roundRect(hwState.ctx, barLeft, ny - barH / 2, barRight - barLeft, barH, 2);
                hwState.ctx.fill();
                _paintGemGlow(hwState, (barLeft + barRight) / 2, ny, barH * 0.5, cn.s, cnNs);
                const fontSize = Math.max(8, sz * 0.5) | 0;
                hwState.ctx.fillStyle = '#fff';
                hwState.ctx.font = `bold ${fontSize}px sans-serif`;
                hwState.ctx.textAlign = 'center';
                hwState.ctx.textBaseline = 'middle';
                fillTextReadable(hwState, '0', (barLeft + barRight) / 2, ny);
            } else {
                drawNote(hwState, W, H, x, ny, p.scale, cn.s, cn.f, { ...cn, chord: true }, cnNs);
            }

            // Nullish-coalesce (??) rather than `||`: undefined / null
            // from missing bend data still maps to 0 (matches historic
            // encoding — old code shipped `entry.bn = cn.bn || 0`), but
            // NaN stays NaN so it fails BOTH the strict-equality branch
            // below and the `> 0` branch — keeping bad data out of the
            // unbent connector set rather than silently classifying it
            // as unbent.
            const cnBn = cn.bn ?? 0;
            const entry = { s: cn.s, f: cn.f, bn: cnBn, x, y: ny, scale: p.scale };
            if (cnBn > 0) bent.push(entry);
            else if (cnBn === 0) unbent.push(entry);
        }

        // Unison bend within chord — bent / unbent classified inline above.
        if (bent.length > 0 && unbent.length > 0 && sz >= 14) {
            for (const bn of bent) {
                let closest = unbent[0];
                for (const ub of unbent) {
                    if (Math.abs(ub.s - bn.s) < Math.abs(closest.s - bn.s)) closest = ub;
                }
                const x1 = bn.x, y1 = bn.y;
                const x2 = closest.x, y2 = closest.y;
                const midX = (x1 + x2) / 2 + sz * 0.5;
                const midY = (y1 + y2) / 2;

                hwState.ctx.save();
                hwState.ctx.strokeStyle = '#60d0ff';
                hwState.ctx.lineWidth = Math.max(2, sz / 12);
                hwState.ctx.setLineDash([4, 4]);
                hwState.ctx.beginPath();
                hwState.ctx.moveTo(x1, y1);
                hwState.ctx.quadraticCurveTo(midX, midY, x2, y2);
                hwState.ctx.stroke();
                hwState.ctx.setLineDash([]);
                hwState.ctx.restore();

                const labelSz = Math.max(10, sz * 0.3) | 0;
                hwState.ctx.fillStyle = '#60d0ff';
                hwState.ctx.font = `bold ${labelSz}px sans-serif`;
                hwState.ctx.textAlign = 'center';
                hwState.ctx.textBaseline = 'middle';
                const cpX = (x1 + 2 * midX + x2) / 4;
                const cpY = (y1 + 2 * midY + y2) / 4;
                fillTextReadable(hwState, 'U', cpX + sz * 0.3, cpY);
            }
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────

// Live-tunable lyric display window, persisted as JSON under
// localStorage['lyricsDisplay'] and settable in-game via
// highway.setLyricsDisplay({upcomingLines, lookaheadSec}). Read per frame
// behind a raw-string compare so a tweak takes effect on the next frame
// without a reload.
//   upcomingLines — how many lines beyond the current one may be shown (0-4)
//   lookaheadSec  — how far ahead a line may start and still be previewed (1-30)
const LYRICS_DISPLAY_DEFAULTS = { upcomingLines: 2, lookaheadSec: 8 };
let _lyricsCfgRaw;
let _lyricsCfg = LYRICS_DISPLAY_DEFAULTS;
export function getLyricsDisplayCfg() {
    let raw = null;
    try { raw = localStorage.getItem('lyricsDisplay'); } catch (e) { /* storage denied */ }
    if (raw === _lyricsCfgRaw) return _lyricsCfg;
    _lyricsCfgRaw = raw;
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { /* corrupt -> defaults */ }
    if (!parsed || typeof parsed !== 'object') parsed = {};
    const num = (v, dflt, lo, hi) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
    };
    _lyricsCfg = {
        upcomingLines: num(parsed.upcomingLines, LYRICS_DISPLAY_DEFAULTS.upcomingLines, 0, 4) | 0,
        lookaheadSec: num(parsed.lookaheadSec, LYRICS_DISPLAY_DEFAULTS.lookaheadSec, 1, 30),
    };
    return _lyricsCfg;
}

export function drawLyrics(hwState, W, H) {
    if (!hwState.lyrics.length) return;

    const fontSize = Math.max(18, H * 0.028) | 0;
    const lineY = H * 0.04;
    const cfg = getLyricsDisplayCfg();

    // Vocal markers: a trailing "-" means the syllable joins the
    // next one into a single word (no space); a trailing "+" marks the end
    // of an authored line. Build a flat list of authored lines so we can
    // cap rendering to a 2-line rolling window (current + upcoming).
    if (!hwState.lyrics._lines) {
        const lines = [];
        let line = null, word = null;

        const flushWord = () => {
            if (word && word.length) line.words.push(word);
            word = null;
        };
        const flushLine = () => {
            flushWord();
            if (line && line.words.length) lines.push(line);
            line = null;
        };

        for (let i = 0; i < hwState.lyrics.length; i++) {
            const l = hwState.lyrics[i];
            const raw = l.w || '';
            const endsLine = raw.endsWith('+');
            const continuesWord = raw.endsWith('-');

            // Safety fallback: if a song has no "+" markers at all, force a
            // line break on any gap > 4s so we never build a single giant line.
            if (line && i > 0) {
                const prev = hwState.lyrics[i - 1];
                if (l.t - (prev.t + prev.d) > 4.0) flushLine();
            }

            if (!line) line = { words: [], start: l.t, end: l.t + l.d };
            if (!word) word = [];

            word.push(l);
            line.end = Math.max(line.end, l.t + l.d);

            if (!continuesWord) flushWord();
            if (endsLine) flushLine();
        }
        flushLine();

        hwState.lyrics._lines = lines;
    }

    const allLines = hwState.lyrics._lines;
    if (!allLines.length) return;

    const sylText = (s) => {
        const t = s.w || '';
        return (t.endsWith('+') || t.endsWith('-')) ? t.slice(0, -1) : t;
    };

    hwState.ctx.font = `bold ${fontSize}px sans-serif`;
    const maxWidth = W * 0.8;

    // Display lines: authored lines pre-split at word boundaries so every
    // display line fits maxWidth — one display line is exactly one rendered
    // row. This is what keeps a giant transcribed line (word-timed lyrics
    // break only on long gaps) from blowing up into an unbounded wrap block:
    // its segments become ordinary lines that scroll through the window
    // below. Cached per (lyrics, fontSize, W); measure work never runs per
    // frame.
    let layout = hwState._lyricLayout;
    if (!layout || layout.lyricsRef !== hwState.lyrics || layout.fontSize !== fontSize || layout.W !== W) {
        const spaceWidth = _measureLyricText(hwState, hwState.ctx, fontSize, ' ');
        const displayLines = [];
        for (const authoredLine of allLines) {
            let row = [], rowWidth = 0, start = null, end = null;
            const flushRow = () => {
                if (!row.length) return;
                displayLines.push({ row, width: rowWidth - spaceWidth, start, end });
                row = []; rowWidth = 0; start = null; end = null;
            };
            for (const wordSyls of authoredLine.words) {
                const parts = [];
                let wordWidth = 0;
                for (const s of wordSyls) {
                    const text = sylText(s);
                    const w = _measureLyricText(hwState, hwState.ctx, fontSize, text);
                    parts.push({ syl: s, text, width: w });
                    wordWidth += w;
                }
                const advance = wordWidth + spaceWidth;
                if (row.length > 0 && rowWidth + advance > maxWidth) flushRow();
                row.push({ parts, advance });
                rowWidth += advance;
                const first = wordSyls[0], last = wordSyls[wordSyls.length - 1];
                if (start === null) start = first.t;
                end = end === null ? last.t + last.d : Math.max(end, last.t + last.d);
            }
            flushRow();
        }
        layout = hwState._lyricLayout = { lyricsRef: hwState.lyrics, fontSize, W, spaceWidth, displayLines };
    }
    const displayLines = layout.displayLines;
    const spaceWidth = layout.spaceWidth;
    if (!displayLines.length) return;

    // Rolling window: the current line plus up to cfg.upcomingLines of
    // context. An upcoming line joins the window once it starts within
    // cfg.lookaheadSec (this also serves as the pre-song preview window).
    let currentIdx = -1;
    for (let i = 0; i < displayLines.length; i++) {
        if (displayLines[i].start <= hwState.currentTime) currentIdx = i;
        else break;
    }
    const nextLine = displayLines[currentIdx + 1] || null;
    // Hide once the current line is clearly over and nothing upcoming is
    // close enough to preview.
    if (currentIdx >= 0
        && hwState.currentTime > displayLines[currentIdx].end + 0.5
        && (!nextLine || nextLine.start - hwState.currentTime > cfg.lookaheadSec)) {
        return;
    }

    const maxLines = 1 + cfg.upcomingLines;
    const startIdx = currentIdx === -1 ? 0 : currentIdx;
    const shown = [];
    for (let i = startIdx; i < displayLines.length && shown.length < maxLines; i++) {
        if (i !== currentIdx && displayLines[i].start - hwState.currentTime > cfg.lookaheadSec) break;
        shown.push(displayLines[i]);
    }
    if (!shown.length) return;

    const rowHeight = fontSize + 6;
    const totalHeight = shown.length * rowHeight + 10;
    let bgWidth = 0;
    for (const dl of shown) {
        if (dl.width > bgWidth) bgWidth = dl.width;
    }
    bgWidth = Math.min(bgWidth + 30, W * 0.85);

    hwState.ctx.fillStyle = 'rgba(0,0,0,0.7)';
    roundRect(hwState.ctx, W/2 - bgWidth/2, lineY - 4, bgWidth, totalHeight, 8);
    hwState.ctx.fill();

    hwState.ctx.textAlign = 'left';
    hwState.ctx.textBaseline = 'top';

    for (let r = 0; r < shown.length; r++) {
        const row = shown[r].row;
        let xPos = W/2 - shown[r].width/2;
        const yPos = lineY + r * rowHeight + 2;

        for (const w of row) {
            for (const part of w.parts) {
                const l = part.syl;
                const isActive = hwState.currentTime >= l.t && hwState.currentTime < l.t + l.d;
                const isPast = hwState.currentTime >= l.t + l.d;

                if (isActive) {
                    hwState.ctx.fillStyle = '#4ae0ff';
                    hwState.ctx.font = `bold ${fontSize}px sans-serif`;
                } else if (isPast) {
                    hwState.ctx.fillStyle = '#8899aa';
                    hwState.ctx.font = `normal ${fontSize}px sans-serif`;
                } else {
                    hwState.ctx.fillStyle = '#556677';
                    hwState.ctx.font = `normal ${fontSize}px sans-serif`;
                }

                hwState.ctx.fillText(part.text, xPos, yPos);
                xPos += part.width;
            }
            xPos += spaceWidth;
        }
    }
}

export function bsearch(arr, time) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].t < time) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

export function bsearchChords(arr, time) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].t < time) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// True if a chord note carries per-strum technique data (bend,
// hammer/pull/tap, slide, palm-mute, vibrato, tremolo, accent, harmonic, pinch
// harmonic, dead note). drawNote shows these in 3D (`ac` accent is a brighter
// gem instead of a glyph there). Alternate render paths (repeat box,
// open-string-in-chord wide bar)
// bypass drawNote and so must fall back to the full path whenever a
// technique flag is present, otherwise authored cues vanish silently.
export function _noteHasTechniqueFlags(n) {
    if (n.bn || n.ho || n.po || n.tp || n.pm || n.vb || n.tr || n.ac || n.hm || n.hp || n.mt || n.fhm) return true;
    if (typeof n.sl === 'number' && n.sl >= 0) return true;
    return false;
}

export function _chordHasTechniqueFlags(ch) {
    const notes = ch.notes;
    for (let i = 0; i < notes.length; i++) {
        if (_noteHasTechniqueFlags(notes[i])) return true;
    }
    return false;
}

// Template lookup: returns helpers that classify a chord note's fret
// against its template. Open = template fret 0 (regardless of cn.f).
export function getChordTemplateInfo(chordId, chordTemplates) {
    const tmpl = chordTemplates[chordId];
    const tmplFrets = tmpl && tmpl.frets ? tmpl.frets : [];
    const getTemplateFret = (cn) => cn.s < tmplFrets.length ? tmplFrets[cn.s] : cn.f;
    const isOpen = (cn) => getTemplateFret(cn) === 0;
    return { tmpl, tmplFrets, getTemplateFret, isOpen };
}

// Effective chord templates: an active chart transform substitutes its
// re-indexed table (identity change also invalidates the render cache).
export function _effChordTemplates(hwState) {
    return hwState._xfChordTemplates !== null ? hwState._xfChordTemplates : hwState.chordTemplates;
}

// Build _chordRenderInfo for every chord in `src` if the cache is stale.
// Two passes over the array: chain bounds, then base-fret resolution
// (which can read previous chord's cached baseFret).
export function _ensureChordRenderCache(hwState, src) {
    const effTemplates = _effChordTemplates(hwState);
    const templatesChanged = hwState._chordRenderCacheTemplates !== effTemplates;
    if (hwState._chordRenderCacheSrc === src && hwState._chordRenderCacheInverted === hwState._inverted && !templatesChanged) return;
    hwState._chordRenderCacheSrc = src;
    hwState._chordRenderCacheInverted = hwState._inverted;
    hwState._chordRenderCacheTemplates = effTemplates;
    // Templates feed isOpen() — when they land after `chords`,
    // _updateFretLinePreview's stashed open/non-open classification
    // for the currently-active chord is also stale. It only refreshes
    // on the next chord transition, so force a refresh here.
    if (templatesChanged) {
        hwState._lastChordOnFretLine = null;
        hwState._chordFretLineNotes = [];
        // Also clear the once-per-chord-id frame-mismatch warner —
        // a chord ID warned against stale (missing/empty) templates
        // would otherwise never be re-validated against the
        // corrected templates that just landed.
        hwState._frameMismatchWarned.clear();
    }

    // Pass 1: walk forward, marking chain index / length / isFull on a
    // per-chord WeakMap entry. A chain breaks when the next chord has a
    // different id OR the time gap is >= CHAIN_GAP_THRESHOLD.
    // Chords that carry per-strum technique flags (bend / palm-mute /
    // hammer / pull / tap / slide / vibrato / tremolo / accent / harmonic / mute)
    // never collapse to a repeat box — those cues are authored on each
    // strum and must stay visible.
    let chainStart = 0;
    for (let i = 0; i <= src.length; i++) {
        const breakHere = (i === src.length) ||
            (i > chainStart && (src[i].id !== src[i - 1].id ||
                Math.abs(src[i].t - src[i - 1].t) >= CHAIN_GAP_THRESHOLD));
        if (breakHere && i > chainStart) {
            const len = i - chainStart;
            for (let k = chainStart; k < i; k++) {
                const chainIndex = k - chainStart;
                const hasTechniques = _chordHasTechniqueFlags(src[k]);
                hwState._chordRenderInfo.set(src[k], {
                    chainIndex,
                    chainLen: len,
                    isFull: len < CHAIN_RENDER_FULL_MAX || chainIndex === 0 || hasTechniques,
                    baseFret: 0,        // filled in pass 2
                    sortedNotes: null,   // ↓ all filled in pass 2 — cached to skip
                    nonZeroNotes: null,  //   per-frame sort/filter/min/max in drawChords.
                    nonZeroFrets: null,
                    allMuted: false,
                    hasMultipleNotes: false,
                });
            }
            chainStart = i;
        }
    }

    // Pass 2: resolve baseFret. Fretted chords use their own lowest
    // non-open fret; chained same-id chords inherit from the previous
    // entry; open-only / muted chords with a different-id predecessor
    // inherit that predecessor's frame too. The walk is forward so
    // prev's cached value is always present when we read it.
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        const info = hwState._chordRenderInfo.get(ch);
        const { isOpen } = getChordTemplateInfo(ch.id, effTemplates);
        const sortedNotes = [...ch.notes].sort((a, b) => hwState._inverted ? b.s - a.s : a.s - b.s);
        const nonZero = sortedNotes.filter(cn => !isOpen(cn));
        const nonZeroFrets = nonZero.map(cn => cn.f);
        if (nonZero.length >= 1) {
            let minF = nonZeroFrets[0];
            for (let j = 1; j < nonZeroFrets.length; j++) if (nonZeroFrets[j] < minF) minF = nonZeroFrets[j];
            info.baseFret = minF;
        } else if (i > 0) {
            const prevInfo = hwState._chordRenderInfo.get(src[i - 1]);
            info.baseFret = prevInfo ? prevInfo.baseFret : 0;
        } else {
            info.baseFret = 0;
        }
        info.sortedNotes = sortedNotes;
        info.nonZeroNotes = nonZero;
        info.nonZeroFrets = nonZeroFrets;
        info.hasMultipleNotes = sortedNotes.length >= 2;
        let allMuted = sortedNotes.length > 0;
        if (allMuted) {
            for (let j = 0; j < sortedNotes.length; j++) {
                if (!(sortedNotes[j].mt || sortedNotes[j].fhm)) { allMuted = false; break; }
            }
        }
        info.allMuted = allMuted;
    }
}

// Compute the on-screen box for a chord (used by both muted and repeat
// box renderings). Box height tracks the per-string note positions; box
// width spans the CHORD_FRAME_FRETS frame anchored at info.baseFret.
export function _computeChordBox(hwState, p, H, W, sorted, sz, actualSpread, baseFret) {
    const actualTotalH = actualSpread * Math.max(0, sorted.length - 1);
    const yCenter = p.y * H;
    const boxTop = yCenter - actualTotalH / 2 - sz * 0.5;
    const boxBottom = boxTop + Math.max(sz, actualTotalH + sz);
    const boxX = fretX(hwState, baseFret, p.scale, W);
    const boxW = fretX(hwState, baseFret + CHORD_FRAME_FRETS, p.scale, W) - boxX;
    return { boxX, boxW, boxTop, boxH: boxBottom - boxTop };
}

// Search [lo, hi) for the chord we should preview on the static fret
// line. Prefer the chord nearest the strum line that's within
// [target - before, target + after]; if none match, fall back to the
// first visible chord. Updates _lastChordOnFretLine / _chordFretLineNotes
// only when the active chord changes (lets the preview persist while a
// chord is held).
export function _updateFretLinePreview(hwState, src, lo, hi) {
    const targetTime = hwState.currentTime + FRETLINE_TARGET_OFFSET;
    let activeChord = null;
    let activeNotesOnFret = [];
    let bestChordTime = -Infinity;

    for (let i = lo; i < hi; i++) {
        const ch = src[i];
        if (ch.t >= targetTime - FRETLINE_WINDOW_BEFORE &&
            ch.t < targetTime + FRETLINE_WINDOW_AFTER &&
            ch.t > bestChordTime) {
            bestChordTime = ch.t;
            activeChord = ch;
            const { isOpen } = getChordTemplateInfo(ch.id, _effChordTemplates(hwState));
            const nonZero = ch.notes.filter(cn => !isOpen(cn));
            activeNotesOnFret = nonZero.length >= 1 ? nonZero.map(cn => ({ s: cn.s, f: cn.f })) : [];
        }
    }

    if (activeChord === null) {
        for (let i = lo; i < hi; i++) {
            const ch = src[i];
            const p = project(ch.t - hwState.currentTime);
            if (!p) continue;
            activeChord = ch;
            const { isOpen } = getChordTemplateInfo(ch.id, _effChordTemplates(hwState));
            const nonZero = ch.notes.filter(cn => !isOpen(cn));
            activeNotesOnFret = nonZero.length >= 1 ? nonZero.map(cn => ({ s: cn.s, f: cn.f })) : [];
            break;
        }
    }

    // Compare by chord OBJECT identity rather than .id — two strums of
    // the same chord template are different objects, so a chain like
    // (G normal) → (G all-muted) refreshes the preview instead of
    // leaving the first strum's fingerings stuck on the fret line.
    if (activeChord !== hwState._lastChordOnFretLine) {
        hwState._chordFretLineNotes = activeNotesOnFret;
        hwState._lastChordOnFretLine = activeChord;
    }
}

export function _drawFretLineChordPreview(hwState, W, H) {
    if (hwState._chordFretLineNotes.length === 0) return;
    const strTop = H * 0.83;
    const strBot = H * 0.95;
    // Scale glyphs with H so preview stays proportionate at any
    // resolution / renderScale. Constants picked to match the prior
    // hardcoded 30px diameter / 24px font at H=900.
    const noteSize = Math.max(14, H * 0.033);
    const fontSize = Math.max(11, H * 0.027) | 0;
    hwState.ctx.font = `bold ${fontSize}px sans-serif`;
    hwState.ctx.textAlign = 'center';
    hwState.ctx.textBaseline = 'middle';
    for (const cn of hwState._chordFretLineNotes) {
        const yi = hwState._inverted ? 5 - cn.s : cn.s;
        const syl = strTop + (yi / 5) * (strBot - strTop);
        const fretXPos = fretX(hwState, cn.f, 1, W);
        hwState.ctx.fillStyle = hwState.STRING_COLORS[cn.s] || '#888';
        hwState.ctx.beginPath();
        hwState.ctx.arc(fretXPos, syl, noteSize / 2, 0, Math.PI * 2);
        hwState.ctx.fill();
        hwState.ctx.fillStyle = '#fff';
        fillTextReadable(hwState, String(cn.f), fretXPos, syl);
    }
}
