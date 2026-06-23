/*
 * fee[dB]ack v0.3.0 — Pedalboard patch cables (decorative).
 *
 * Draws purely cosmetic 1/4" patch cables between the pedals on each board of
 * the v3 Plugins page (#v3-plugins). Cables carry NO routing/audio meaning —
 * they're eye candy. A light Verlet "rope" makes each cable sag under gravity
 * and swing slightly, settling on load and reacting to drags / resize / scroll.
 *
 * Constraints honoured:
 *  - The SVG overlay is `pointer-events:none` so it never blocks pedal clicks.
 *  - One shared requestAnimationFrame loop; it runs ONLY while #v3-plugins is the
 *    active screen and stops when the screen is hidden (hooked off the same
 *    `screen:changed` event plugins-page uses).
 *  - `prefers-reduced-motion: reduce` → static (sagged but not swinging) cables,
 *    no rAF. A live drag still gets a one-shot redraw via refresh().
 *  - Cheap: a handful of segments per cable, anchors recomputed from
 *    getBoundingClientRect() each active frame so cables track moved pedals.
 */
(function () {
    'use strict';

    var SEGMENTS = 12;          // points per seeded cable (used by the pure helpers/tests)
    var MAX_CABLES = 200;       // hard cap so a pathological board can't explode
    var CABLE_SAG = 0.06;       // dip of the cable curve as a fraction of its span (small = rigid)
    var SCREEN_ID = 'v3-plugins';
    // Distance from the socket (plug tip) to the boot end where the cable
    // actually attaches — matches makePlug()'s boot outer edge. The rope is
    // pinned here (NOT at the socket), so the cable connects to the END of the
    // jack. Pedal spacing (GAP_X in plugins-page.js) must exceed 2×this so two
    // facing plugs leave room for visible cable between them.
    var PLUG_BOOT = 44;
    // Cable anchors sit at this fraction of the pedal's height (the side jacks on
    // the pedal photos measure ~57.5% down), so they stay aligned at any size.
    var JACK_FRAC = 0.575;

    var sm = window.feedBack;

    // ---- pure geometry helpers (exported for tests) -----------------------

    // Jacks sit on the pedal's SIDE faces like a real stompbox: output on the
    // RIGHT edge, input on the LEFT edge, both at the pedal's vertical centre —
    // so a cable runs side-to-side into the next pedal. Board-relative so the
    // overlay viewBox lines up regardless of page scroll. The small default
    // inset tucks the plug tip just inside the edge socket (.v3-pedal-jack in
    // v3.css straddles the side edge). A single `inset` keeps the symmetric
    // behaviour the unit test relies on.
    function computeJacks(pedalRect, boardRect, inset) {
        var i = inset == null ? 1 : inset;
        var midY = (pedalRect.top - boardRect.top) + JACK_FRAC * (pedalRect.bottom - pedalRect.top);
        return {
            out: { x: pedalRect.right - boardRect.left - i, y: midY },   // right side
            in: { x: pedalRect.left - boardRect.left + i, y: midY },     // left side
        };
    }

    function dist(a, b) { var dx = b.x - a.x, dy = b.y - a.y; return Math.sqrt(dx * dx + dy * dy); }

    // Initial straight-line seeding of a cable's points between a and b.
    function seedPoints(a, b, segments) {
        var n = Math.max(2, segments | 0);
        var pts = [];
        for (var i = 0; i < n; i++) {
            var t = i / (n - 1);
            var x = a.x + (b.x - a.x) * t;
            var y = a.y + (b.y - a.y) * t;
            pts.push({ x: x, y: y, px: x, py: y });
        }
        return pts;
    }

    // Build an SVG path string through a list of {x,y} points (smooth-ish).
    function pointsToPath(pts) {
        if (!pts || pts.length < 2) return '';
        var d = 'M ' + pts[0].x.toFixed(1) + ' ' + pts[0].y.toFixed(1);
        for (var i = 1; i < pts.length; i++) {
            d += ' L ' + pts[i].x.toFixed(1) + ' ' + pts[i].y.toFixed(1);
        }
        return d;
    }

    // Static sagged cable (reduced-motion / no-physics): a quadratic with its
    // control point pushed below the midpoint by `sag` (scaled to span).
    function staticCablePath(a, b, sag) {
        var mx = (a.x + b.x) / 2;
        var my = (a.y + b.y) / 2;
        var span = dist(a, b);
        var drop = (sag == null ? CABLE_SAG : sag) * span + 4;
        return 'M ' + a.x.toFixed(1) + ' ' + a.y.toFixed(1) +
            ' Q ' + mx.toFixed(1) + ' ' + (my + drop).toFixed(1) +
            ' ' + b.x.toFixed(1) + ' ' + b.y.toFixed(1);
    }

    var SVG_NS = 'http://www.w3.org/2000/svg';

    function reducedMotion() {
        try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
        catch (e) { return false; }
    }

    // ---- 1/4" plug graphics (vector, drawn at each cable end) --------------

    function _rect(x, y, w, h, r, fill) {
        var e = document.createElementNS(SVG_NS, 'rect');
        e.setAttribute('x', x); e.setAttribute('y', y);
        e.setAttribute('width', w); e.setAttribute('height', h);
        if (r) { e.setAttribute('rx', r); e.setAttribute('ry', r); }
        e.setAttribute('fill', fill);
        return e;
    }

    // Chrome (cross-axis sheen) + boot gradients, one set per board svg so the
    // url(#id) references stay unique across overlays.
    function makeDefs(idx) {
        var defs = document.createElementNS(SVG_NS, 'defs');
        function grad(id, stops) {
            var g = document.createElementNS(SVG_NS, 'linearGradient');
            g.setAttribute('id', id);
            g.setAttribute('x1', '0'); g.setAttribute('y1', '0');
            g.setAttribute('x2', '0'); g.setAttribute('y2', '1');     // across the barrel
            stops.forEach(function (s) {
                var st = document.createElementNS(SVG_NS, 'stop');
                st.setAttribute('offset', s[0]); st.setAttribute('stop-color', s[1]);
                g.appendChild(st);
            });
            defs.appendChild(g);
        }
        grad('v3plug-chrome-' + idx, [
            ['0', '#f8fafc'], ['0.22', '#cbd5e1'], ['0.5', '#5b6b7b'],
            ['0.78', '#cbd5e1'], ['1', '#3a4756'],
        ]);
        grad('v3plug-boot-' + idx, [['0', '#3b4252'], ['0.5', '#1c2230'], ['1', '#0a0d13']]);
        return defs;
    }

    // A plug pointing along +x with its metal tip at the origin (the socket).
    // boot (cable strain-relief) → barrel → insulator ring → tip sleeve → cap.
    function makePlug(idx) {
        var g = document.createElementNS(SVG_NS, 'g');
        g.setAttribute('class', 'v3-cable-plug');
        var chrome = 'url(#v3plug-chrome-' + idx + ')';
        // Chunkier plug sized to match the pedal photo's 1/4" jack barrels.
        g.appendChild(_rect(26, -11, 18, 22, 6, 'url(#v3plug-boot-' + idx + ')'));   // boot
        g.appendChild(_rect(6, -9, 22, 18, 3, chrome));                              // barrel
        g.appendChild(_rect(16, -9, 2, 18, 0, 'rgba(0,0,0,.35)'));                   // barrel rib
        g.appendChild(_rect(3, -10, 4, 20, 1.5, '#0a0d13'));                         // insulator ring
        g.appendChild(_rect(-7, -6, 11, 12, 5, chrome));                            // tip sleeve
        var cap = document.createElementNS(SVG_NS, 'circle');
        cap.setAttribute('cx', -6); cap.setAttribute('cy', 0); cap.setAttribute('r', 5.5);
        cap.setAttribute('fill', chrome);
        g.appendChild(cap);
        return g;
    }

    // Orient a plug group so its tip sits at `tip` and points toward `toward`.
    function placePlug(g, tip, toward) {
        if (!g) return;
        var ang = Math.atan2(toward.y - tip.y, toward.x - tip.x) * 180 / Math.PI;
        g.setAttribute('transform',
            'translate(' + tip.x.toFixed(1) + ',' + tip.y.toFixed(1) + ') rotate(' + ang.toFixed(1) + ')');
    }

    // ---- state ------------------------------------------------------------

    var boards = [];            // [{ el, svg, cables:[{a,b,pts,el,restLen}] }]
    var rafId = 0;
    var active = false;         // is #v3-plugins the current screen?
    var dragForce = false;      // a drag is in progress → run even under RM

    function cancelLoop() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }

    // Recompute the two pinned endpoints of every cable from current layout.
    function repinAnchors() {
        for (var bi = 0; bi < boards.length; bi++) {
            var b = boards[bi];
            var brect = b.el.getBoundingClientRect();
            // Size overlay to the board's full scrollable area.
            var w = b.el.scrollWidth, h = b.el.scrollHeight;
            b.svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
            b.svg.setAttribute('width', w);
            b.svg.setAttribute('height', h);
            for (var ci = 0; ci < b.cables.length; ci++) {
                var c = b.cables[ci];
                var ra = c.fromEl.getBoundingClientRect();
                var rb = c.toEl.getBoundingClientRect();
                c.a = computeJacks(ra, brect).out;   // output socket (right side)
                c.b = computeJacks(rb, brect).in;    // input socket (left side)
                // Rope attaches at each plug's BOOT end, not the socket: output
                // plug extends +x, input plug extends -x.
                c.ra = { x: c.a.x + PLUG_BOOT, y: c.a.y };
                c.rb = { x: c.b.x - PLUG_BOOT, y: c.b.y };
            }
        }
    }

    // The plugs are rigid: the output jack (right side) always points straight
    // out to the right, the input jack (left side) straight out to the left —
    // they do NOT swing with the cable. Only the rope between them dips.
    function placeRigidPlugs(c) {
        placePlug(c.plugA, c.a, { x: c.a.x + 1, y: c.a.y });   // output → +x
        placePlug(c.plugB, c.b, { x: c.b.x - 1, y: c.b.y });   // input  → -x
    }

    // Draw every cable as a curve computed DIRECTLY from its current endpoints —
    // no Verlet, no inertia, no momentum. The shape is a pure function of where
    // the pedals are right now, so it tracks a dragged pedal exactly (1:1) with
    // zero float / slow-motion drift. A tiny gravity-biased dip gives it a
    // natural hang without any springiness.
    function drawAll() {
        for (var bi = 0; bi < boards.length; bi++) {
            var cs = boards[bi].cables;
            for (var ci = 0; ci < cs.length; ci++) {
                var c = cs[ci];
                c.el.setAttribute('d', staticCablePath(c.ra, c.rb));
                placeRigidPlugs(c);
            }
        }
    }

    // Single render pass: refresh anchors from the live layout, then draw.
    function render() {
        if (!boards.length) return;
        repinAnchors();
        drawAll();
    }

    // During a drag we run a short rAF loop purely so the cable re-reads the
    // pedal's getBoundingClientRect every frame and stays glued to it; outside a
    // drag there's nothing to animate, so we render on demand only (no idle
    // loop, no physics to settle → nothing to look like the moon).
    function tick() {
        rafId = 0;
        if (!dragForce) { render(); return; }   // final frame, then stop
        render();
        rafId = requestAnimationFrame(tick);
    }

    function start() { if (boards.length) render(); }
    function stop() { cancelLoop(); }

    function refresh() { if (boards.length) render(); }

    // Called by plugins-page around a pedal drag.
    function setDragging(on) {
        dragForce = !!on;
        if (dragForce) { if (!rafId) rafId = requestAnimationFrame(tick); }
        else render();
    }

    // (Re)build overlays + cable lists for the current board DOM. Called by
    // plugins-page after every render() (which rebuilds the board markup).
    function attach(rootEl) {
        cancelLoop();
        boards = [];
        if (!rootEl) return;
        var boardEls = rootEl.querySelectorAll('.v3-pedalboard');
        var total = 0;
        for (var bi = 0; bi < boardEls.length; bi++) {
            var el = boardEls[bi];
            var svg = document.createElementNS(SVG_NS, 'svg');
            svg.setAttribute('class', 'v3-cable-layer');
            svg.setAttribute('aria-hidden', 'true');
            svg.appendChild(makeDefs(bi));
            el.insertBefore(svg, el.firstChild);
            var pedals = el.querySelectorAll('.v3-pedal');
            var cables = [];
            for (var pi = 0; pi + 1 < pedals.length && total < MAX_CABLES; pi++) {
                var path = document.createElementNS(SVG_NS, 'path');
                path.setAttribute('class', 'v3-cable');
                svg.appendChild(path);
                // Plug graphics go on TOP of the path so the cable reads as
                // entering the boot.
                var plugA = makePlug(bi), plugB = makePlug(bi);
                svg.appendChild(plugA); svg.appendChild(plugB);
                cables.push({
                    fromEl: pedals[pi], toEl: pedals[pi + 1],
                    a: { x: 0, y: 0 }, b: { x: 0, y: 0 },
                    ra: { x: 0, y: 0 }, rb: { x: 0, y: 0 },
                    el: path, plugA: plugA, plugB: plugB,
                });
                total++;
            }
            boards.push({ el: el, svg: svg, cables: cables });
        }
        render();
    }

    function destroy() { cancelLoop(); boards = []; }

    // ---- wiring -----------------------------------------------------------

    // Pause/resume with the screen. screen:changed fires with the NEW screen id
    // on every navigation, so this covers both enter and leave.
    if (sm && typeof sm.on === 'function') {
        sm.on('screen:changed', function (e) {
            var id = e && e.detail && e.detail.id;
            if (id === SCREEN_ID) { active = true; start(); }
            else { active = false; stop(); }
        });
    }
    // Recompute on viewport changes (throttled via rAF-coalescing in refresh()).
    var pending = false;
    function onLayout() {
        if (!active && !dragForce) return;
        if (pending) return;
        pending = true;
        requestAnimationFrame(function () { pending = false; refresh(); });
    }
    window.addEventListener('resize', onLayout, { passive: true });
    // Scroll can change board rects relative to viewport; getBoundingClientRect
    // already accounts for it, but a moved pedal mid-scroll wants a redraw.
    window.addEventListener('scroll', onLayout, { passive: true, capture: true });

    window.v3PedalCables = {
        attach: attach,
        refresh: refresh,
        setDragging: setDragging,
        start: start,
        stop: stop,
        destroy: destroy,
        // Mark active without waiting for a screen:changed (plugins-page calls
        // this when it renders while already on the plugins screen at boot).
        markActive: function (on) { active = !!on; if (active) start(); else stop(); },
        // Pure helpers exposed for unit tests.
        _test: {
            computeJacks: computeJacks,
            seedPoints: seedPoints,
            pointsToPath: pointsToPath,
            staticCablePath: staticCablePath,
            dist: dist,
            SEGMENTS: SEGMENTS,
            MAX_CABLES: MAX_CABLES, JACK_FRAC: JACK_FRAC,
        },
    };
})();
