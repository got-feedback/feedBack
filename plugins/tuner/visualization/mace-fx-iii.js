/**
 * Mace Fx III style tuner visualization for the FeedBack tuner plugin.
 *
 * Inspired by hardware rack tuner displays:
 *   - Dark navy LCD background
 *   - Horizontal chromatic tick-mark gauge (top)
 *   - Inward-pointing directional arrows (▶ ◀) below gauge
 *   - Large note name (lower-left) and octave number (lower-right)
 *   - Orange dashed strobe circle (bottom centre)
 *   - Mode tabs Free / Auto / Manual (top-right)
 *
 * Contract: window['_tunerViz_mace-fx-iii'](container) → { update(note, cents, freq, mode), destroy() }
 *   - note: string | null  (null = no signal)
 *   - cents: number        (deviation from target, −50…+50)
 *   - freq:  number        (detected frequency in Hz)
 *   - mode:  'free' | 'auto' | 'manual'  (tuning mode from screen.js)
 */
(function () {
    'use strict';

    // ── Constants ─────────────────────────────────────────────────────
    var _TUNER_TICK_COUNT  = 11;
    var _TUNER_STROBE_N    = 4;    // segments fitting in 180° (plus one trailing gap)
    var _TUNER_STROBE_R    = 38;   // radius in SVG units (full circle, fits in 120×120 viewBox)
    var _TUNER_IN_TUNE_THR = 2;    // cents threshold for in-tune state
    var _TUNER_ARROW_THR   = 3;    // cents threshold for arrow direction

    var _SVG_NS = 'http://www.w3.org/2000/svg';

    // ── Colours (custom palette; no Tailwind token equivalents) ──────
    var _COL_BG         = '#0e0e0e';   // dark gray background
    var _COL_TICK       = '#7ad400';   // yellow-green gauge ticks
    var _COL_MARKER     = '#ffffff';   // white pitch-position marker
    var _COL_NOTE       = '#ffffff';   // white note/octave text
    var _COL_ARROW_WH   = '#e8e8e8';   // lit arrow colour
    var _COL_ARROW_DIM  = '#1e3030';   // dimmed arrow colour
    var _COL_STROBE     = '#e87020';   // orange strobe circle
    var _COL_TAB_ACT_BG = '#505868';   // active tab background (slate-gray)
    var _COL_TAB_ACT_FG = '#ffffff';   // active tab text
    var _COL_TAB_DIM    = '#506080';   // inactive tab text

    window['_tunerViz_mace-fx-iii'] = function (container) {
        'use strict';

        // ── Root panel ────────────────────────────────────────────────
        var panel = document.createElement('div');
        panel.className = 'relative w-full overflow-hidden font-mono select-none';
        panel.style.backgroundColor = _COL_BG;
        panel.style.aspectRatio = '16 / 9';
        panel.style.minHeight = '120px';

        // ── Mode tabs (full-width bar, ~12.5% height) ────────────────
        var tabsWrap = document.createElement('div');
        tabsWrap.style.position      = 'absolute';
        tabsWrap.style.top           = '0';
        tabsWrap.style.left          = '0';
        tabsWrap.style.right         = '0';
        tabsWrap.style.height        = '12.5%';
        tabsWrap.style.display       = 'flex';
        tabsWrap.style.alignItems    = 'flex-end';
        tabsWrap.style.justifyContent = 'flex-end';
        tabsWrap.style.borderBottom  = '2px solid ' + _COL_TAB_ACT_BG;
        tabsWrap.style.zIndex        = '10';

        var _tabNames = ['Free', 'Auto', 'Manual'];
        var _tabEls = _tabNames.map(function (name) {
            var tab = document.createElement('span');
            tab.className = 'px-2 py-px text-xs leading-none';
            tab.style.borderRadius = '2px 2px 0 0';
            tab.style.cursor = 'default';
            tab.textContent = name;
            tabsWrap.appendChild(tab);
            return tab;
        });
        panel.appendChild(tabsWrap);

        // ── Gauge + arrows zone (25%→50% from top) ───────────────────
        var gaugeZone = document.createElement('div');
        gaugeZone.style.position      = 'absolute';
        gaugeZone.style.top           = '25%';
        gaugeZone.style.left          = '0';
        gaugeZone.style.right         = '0';
        gaugeZone.style.height        = '25%';
        gaugeZone.style.display       = 'flex';
        gaugeZone.style.flexDirection = 'column';
        gaugeZone.style.justifyContent = 'center';
        gaugeZone.style.zIndex        = '5';

        // Chromatic gauge — ends at 12.5% from each edge
        var gaugeOuter = document.createElement('div');
        gaugeOuter.style.position    = 'relative';
        gaugeOuter.style.marginLeft  = '12.5%';
        gaugeOuter.style.marginRight = '12.5%';
        gaugeOuter.style.flexShrink  = '0';

        var gaugeBg = document.createElement('div');
        gaugeBg.style.position        = 'absolute';
        gaugeBg.style.top             = '22.5%';   // (100% - 55%) / 2, matches flex items-center
        gaugeBg.style.left            = '0';
        gaugeBg.style.right           = '0';
        gaugeBg.style.height          = '55%';
        gaugeBg.style.backgroundColor = 'rgba(0,60,20,0.7)';
        gaugeBg.style.borderRadius    = '2px';
        gaugeOuter.appendChild(gaugeBg);

        var gaugeWrap = document.createElement('div');
        gaugeWrap.className = 'relative flex items-center justify-between';
        gaugeWrap.style.height = '1.4em';

        var _tickEls = [];
        for (var i = 0; i < _TUNER_TICK_COUNT; i++) {
            var isCentre = (i === Math.floor(_TUNER_TICK_COUNT / 2));
            var tick = document.createElement('div');
            tick.style.width           = '2px';
            tick.style.height          = isCentre ? '100%' : '55%';
            tick.style.backgroundColor = _COL_TICK;
            tick.style.borderRadius    = '1px';
            tick.style.flexShrink      = '0';
            tick.style.filter          = 'drop-shadow(0 0 4px rgba(122,212,0,0.35))';
            gaugeWrap.appendChild(tick);
            _tickEls.push(tick);
        }

        var marker = document.createElement('div');
        marker.style.position        = 'absolute';
        marker.style.top             = '0';
        marker.style.bottom          = '0';
        marker.style.width           = '3px';
        marker.style.backgroundColor = _COL_MARKER;
        marker.style.left            = '50%';
        marker.style.transform       = 'translateX(-50%)';
        marker.style.display         = 'none';
        marker.style.zIndex          = '6';
        marker.style.boxShadow       = '0 0 6px 1px rgba(255,255,255,0.6)';
        gaugeWrap.appendChild(marker);

        gaugeOuter.appendChild(gaugeWrap);

        // Spacer: 1/3 of regular tick height (1/3 * 55% * 1.4em ≈ 0.257em)
        var gaugeArrowGap = document.createElement('div');
        gaugeArrowGap.style.height     = '0.257em';
        gaugeArrowGap.style.flexShrink = '0';

        // Direction arrows SVG — outer edges at ±10¢, gap 15% (~3¢)
        var arrowSvg = document.createElementNS(_SVG_NS, 'svg');
        arrowSvg.setAttribute('viewBox', '0 0 100 10');
        arrowSvg.setAttribute('preserveAspectRatio', 'none');
        arrowSvg.style.alignSelf  = 'center';
        arrowSvg.style.width      = '15%';
        arrowSvg.style.height     = '0.77rem';
        arrowSvg.style.flexShrink = '0';
        arrowSvg.style.overflow   = 'visible';

        // SVG glow filter — applied per-polygon so only lit arrows glow
        var _arrowGlowId = 'arrow-glow-' + Math.random().toString(36).slice(2, 8);
        var _arrowDefs   = document.createElementNS(_SVG_NS, 'defs');
        var _arrowFilter = document.createElementNS(_SVG_NS, 'filter');
        _arrowFilter.setAttribute('id', _arrowGlowId);
        _arrowFilter.setAttribute('x', '-80%'); _arrowFilter.setAttribute('y', '-80%');
        _arrowFilter.setAttribute('width', '260%'); _arrowFilter.setAttribute('height', '260%');
        var _fBlur = document.createElementNS(_SVG_NS, 'feGaussianBlur');
        _fBlur.setAttribute('stdDeviation', '1.2'); _fBlur.setAttribute('result', 'blur');
        var _fFlood = document.createElementNS(_SVG_NS, 'feFlood');
        _fFlood.setAttribute('flood-color', 'white'); _fFlood.setAttribute('flood-opacity', '0.5'); _fFlood.setAttribute('result', 'col');
        var _fComp = document.createElementNS(_SVG_NS, 'feComposite');
        _fComp.setAttribute('in', 'col'); _fComp.setAttribute('in2', 'blur'); _fComp.setAttribute('operator', 'in'); _fComp.setAttribute('result', 'glow');
        var _fMerge = document.createElementNS(_SVG_NS, 'feMerge');
        [['glow'], ['SourceGraphic']].forEach(function (n) {
            var mn = document.createElementNS(_SVG_NS, 'feMergeNode'); mn.setAttribute('in', n[0]); _fMerge.appendChild(mn);
        });
        _arrowFilter.appendChild(_fBlur); _arrowFilter.appendChild(_fFlood);
        _arrowFilter.appendChild(_fComp); _arrowFilter.appendChild(_fMerge);
        _arrowDefs.appendChild(_arrowFilter);
        arrowSvg.appendChild(_arrowDefs);

        var arrowLPoly = document.createElementNS(_SVG_NS, 'polygon');
        arrowLPoly.setAttribute('points', '0,0 0,10 42.5,5');
        arrowLPoly.setAttribute('fill', _COL_ARROW_DIM);

        var arrowRPoly = document.createElementNS(_SVG_NS, 'polygon');
        arrowRPoly.setAttribute('points', '100,0 100,10 57.5,5');
        arrowRPoly.setAttribute('fill', _COL_ARROW_DIM);

        arrowSvg.appendChild(arrowLPoly);
        arrowSvg.appendChild(arrowRPoly);
        // Order: arrows → spacer → gauge (arrows on top, gauge underneath)
        gaugeZone.appendChild(arrowSvg);
        gaugeZone.appendChild(gaugeArrowGap);
        gaugeZone.appendChild(gaugeOuter);
        panel.appendChild(gaugeZone);

        var arrowL = arrowLPoly;
        var arrowR = arrowRPoly;
        var _arrowGlowUrl = 'url(#' + _arrowGlowId + ')';

        // ── Note name display ─────────────────────────────────────────
        // Horizontal: center of note letter at 12.5% from left.
        // font-size set on wrapper so `ch` resolves to the note character width.
        // noteLetter is width:1ch so the accidental never shifts the F position.
        var noteWrap = document.createElement('div');
        noteWrap.style.position   = 'absolute';
        noteWrap.style.left       = 'calc(12.5% - 0.5ch)';
        noteWrap.style.top        = '67%';
        noteWrap.style.transform  = 'translateY(-50%)';
        noteWrap.style.height     = '25%';
        noteWrap.style.display    = 'flex';
        noteWrap.style.alignItems = 'center';
        noteWrap.style.fontSize   = '3.2rem';
        noteWrap.style.color      = _COL_NOTE;
        noteWrap.style.zIndex     = '5';
        noteWrap.style.overflow   = 'visible';
        noteWrap.style.textShadow = '0 0 5px rgba(255,255,255,0.4)';

        var noteLetter = document.createElement('span');
        noteLetter.style.display    = 'inline-block';
        noteLetter.style.width      = '1ch';
        noteLetter.style.flexShrink = '0';
        noteLetter.style.fontWeight = '700';
        noteLetter.style.lineHeight = '1';
        noteLetter.textContent      = '-';

        var noteAccidental = document.createElement('span');
        noteAccidental.style.fontSize   = '1.7rem';
        noteAccidental.style.fontWeight = '700';
        noteAccidental.style.lineHeight = '1';
        noteAccidental.style.alignSelf  = 'flex-start';
        noteAccidental.style.marginTop  = '0.15em';
        noteAccidental.textContent      = '';

        noteWrap.appendChild(noteLetter);
        noteWrap.appendChild(noteAccidental);
        panel.appendChild(noteWrap);

        // ── Octave display ────────────────────────────────────────────
        // Center of digit at 12.5% from right; width:1ch pins the element size.
        var octaveEl = document.createElement('div');
        octaveEl.style.position   = 'absolute';
        octaveEl.style.right      = 'calc(12.5% - 0.5ch)';
        octaveEl.style.top        = '67%';
        octaveEl.style.transform  = 'translateY(-50%)';
        octaveEl.style.height     = '25%';
        octaveEl.style.width      = '1ch';
        octaveEl.style.display    = 'flex';
        octaveEl.style.alignItems = 'center';
        octaveEl.style.fontSize   = '3.2rem';
        octaveEl.style.fontWeight = '700';
        octaveEl.style.lineHeight = '1';
        octaveEl.style.color      = _COL_NOTE;
        octaveEl.style.zIndex      = '5';
        octaveEl.style.textShadow  = '0 0 5px rgba(255,255,255,0.4)';
        octaveEl.textContent      = '-';
        panel.appendChild(octaveEl);

        // ── Strobe circle SVG (bottom-centre) ────────────────────────
        // Full dashed circle, centered in the SVG viewBox so no part is clipped.
        // gap = (2/3)*dash; using full circumference for dash calculation.
        var _sVB_W = 120, _sVB_H = 120;
        var _scx = 60, _scy = 60;
        var _halfCirc  = 2 * Math.PI * _TUNER_STROBE_R;   // full circumference
        var _dashLen   = 3 * _halfCirc / 20;
        var _gapLen    = (2 / 3) * _dashLen;

        var strobeSvg = document.createElementNS(_SVG_NS, 'svg');
        strobeSvg.setAttribute('viewBox', '0 0 ' + _sVB_W + ' ' + _sVB_H);
        strobeSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        strobeSvg.setAttribute('class', 'absolute');
        strobeSvg.style.bottom    = '4%';
        strobeSvg.style.left      = '50%';
        strobeSvg.style.transform = 'translateX(-50%)';
        strobeSvg.style.width    = '22%';
        strobeSvg.style.overflow = 'visible';
        strobeSvg.style.zIndex   = '4';

        // SVG glow filter for arc — avoids CSS filter viewport clipping
        var _strobeGlowId = 'strobe-glow-' + Math.random().toString(36).slice(2, 8);
        var _strobeDefs   = document.createElementNS(_SVG_NS, 'defs');
        var _strobeFilter = document.createElementNS(_SVG_NS, 'filter');
        _strobeFilter.setAttribute('id', _strobeGlowId);
        _strobeFilter.setAttribute('x', '-30%'); _strobeFilter.setAttribute('y', '-30%');
        _strobeFilter.setAttribute('width', '160%'); _strobeFilter.setAttribute('height', '160%');
        var _sfBlur = document.createElementNS(_SVG_NS, 'feGaussianBlur');
        _sfBlur.setAttribute('stdDeviation', '2'); _sfBlur.setAttribute('result', 'blur');
        var _sfFlood = document.createElementNS(_SVG_NS, 'feFlood');
        _sfFlood.setAttribute('flood-color', _COL_STROBE); _sfFlood.setAttribute('flood-opacity', '0.45'); _sfFlood.setAttribute('result', 'col');
        var _sfComp = document.createElementNS(_SVG_NS, 'feComposite');
        _sfComp.setAttribute('in', 'col'); _sfComp.setAttribute('in2', 'blur'); _sfComp.setAttribute('operator', 'in'); _sfComp.setAttribute('result', 'glow');
        var _sfMerge = document.createElementNS(_SVG_NS, 'feMerge');
        [['glow'], ['SourceGraphic']].forEach(function (n) {
            var mn = document.createElementNS(_SVG_NS, 'feMergeNode'); mn.setAttribute('in', n[0]); _sfMerge.appendChild(mn);
        });
        _strobeFilter.appendChild(_sfBlur); _strobeFilter.appendChild(_sfFlood);
        _strobeFilter.appendChild(_sfComp); _strobeFilter.appendChild(_sfMerge);
        _strobeDefs.appendChild(_strobeFilter);
        strobeSvg.appendChild(_strobeDefs);

        // Full dashed circle — <circle> supports stroke-dashoffset identically to <path>
        var arcPath = document.createElementNS(_SVG_NS, 'circle');
        arcPath.setAttribute('cx', String(_scx));
        arcPath.setAttribute('cy', String(_scy));
        arcPath.setAttribute('r',  String(_TUNER_STROBE_R));
        arcPath.setAttribute('fill', 'none');
        arcPath.setAttribute('stroke', _COL_STROBE);
        arcPath.setAttribute('stroke-width', String(_dashLen));
        arcPath.setAttribute('stroke-dasharray', _dashLen + ' ' + _gapLen);
        arcPath.setAttribute('stroke-linecap', 'butt');
        arcPath.setAttribute('filter', 'url(#' + _strobeGlowId + ')');
        strobeSvg.appendChild(arcPath);
        panel.appendChild(strobeSvg);

        // ── LCD grid overlay ──────────────────────────────────────────
        // Spans everything below the tab bar (top: 12.5%), 3px cell, bg colour lines.
        var lcdGrid = document.createElement('div');
        lcdGrid.style.position        = 'absolute';
        lcdGrid.style.top             = '12.5%';
        lcdGrid.style.left            = '0';
        lcdGrid.style.right           = '0';
        lcdGrid.style.bottom          = '0';
        lcdGrid.style.zIndex          = '50';
        lcdGrid.style.pointerEvents   = 'none';
        lcdGrid.style.backgroundImage = [
            'repeating-linear-gradient(0deg,  rgba(14,14,14,0.33) 0px, rgba(14,14,14,0.33) 1px, transparent 1px, transparent 2px)',
            'repeating-linear-gradient(90deg, rgba(14,14,14,0.33) 0px, rgba(14,14,14,0.33) 1px, transparent 1px, transparent 2px)'
        ].join(',');
        lcdGrid.style.backgroundPosition = '12.5% 0';
        panel.appendChild(lcdGrid);

        container.appendChild(panel);

        // ── Internal state ────────────────────────────────────────────
        var _rafId         = null;
        var _currentMode   = 'free';
        var _strobeOffset   = 0;      // stroke-dashoffset accumulator (SVG length units)
        var _currentCents   = 0;      // target cents (0 when no signal)
        var _smoothedCents  = 0;      // lerped cents — drives speed, decays to 0 on stop
        var _lastTime       = null;
        var _totalDash      = _dashLen + _gapLen;  // one dash-cycle period

        // ── Strobe RAF animation loop ─────────────────────────────────
        // _smoothedCents lerps toward _currentCents every frame (mirrors strobe.js).
        // When signal stops, _currentCents = 0 → _smoothedCents decays → speed → 0.
        // The strobe always decelerates smoothly rather than snapping to a freeze.
        function _animateStrobe(now) {
            if (_lastTime === null) { _lastTime = now; }
            var dt = Math.min((now - _lastTime) / 1000, 0.1);
            _lastTime = now;

            var lerpFactor = 1 - Math.exp(-10 * dt);
            _smoothedCents += (_currentCents - _smoothedCents) * lerpFactor;

            if (Math.abs(_smoothedCents) > 0.1) {
                var absCents   = Math.min(50, Math.abs(_smoothedCents));
                var normalized = Math.max(0, absCents - _TUNER_IN_TUNE_THR) / (50 - _TUNER_IN_TUNE_THR);
                var speed      = _halfCirc * Math.pow(normalized, 0.9);
                if (_smoothedCents > 0) { speed = -speed; }
                _strobeOffset = ((_strobeOffset + speed * dt) % _totalDash + _totalDash) % _totalDash;
                arcPath.setAttribute('stroke-dashoffset', String(_strobeOffset));
            }

            _rafId = requestAnimationFrame(_animateStrobe);
        }
        _rafId = requestAnimationFrame(_animateStrobe);

        // ── Helper: derive octave number from frequency ───────────────
        function _freqToOctave(freq) {
            if (!freq || freq <= 0) return '-';
            var midi = Math.round(69 + 12 * Math.log2(freq / 440));
            return String(Math.floor(midi / 12) - 1);
        }

        // ── Helper: update mode tab highlights ────────────────────────
        function _updateTabs(mode) {
            var map = { free: 0, auto: 1, manual: 2 };
            var active = (map[mode] !== undefined) ? map[mode] : 0;
            _tabEls.forEach(function (tab, i) {
                if (i === active) {
                    tab.style.backgroundColor = _COL_TAB_ACT_BG;
                    tab.style.color           = _COL_TAB_ACT_FG;
                } else {
                    tab.style.backgroundColor = 'transparent';
                    tab.style.color           = _COL_TAB_DIM;
                }
            });
        }

        // Initialise tabs
        _updateTabs('free');

        // ── Public: update ────────────────────────────────────────────
        function update(note, cents, freq, mode, targetFreq) {
            var hasNote = (note !== null && note !== undefined);

            // Mode tabs
            if (mode !== undefined) { _currentMode = mode; }
            _updateTabs(_currentMode);

            // Gauge marker — clamp cents to [-50,50] so marker stays within gauge bounds
            if (hasNote) {
                marker.style.left    = Math.max(0, Math.min(100, cents + 50)) + '%';
                marker.style.display = 'block';
            } else {
                marker.style.display = 'none';
            }

            // Direction arrows — use setAttribute('filter','none') not removeAttribute
            // so the filter is explicitly cleared on every dim transition
            if (!hasNote) {
                arrowL.setAttribute('fill', _COL_ARROW_DIM); arrowL.setAttribute('filter', 'none');
                arrowR.setAttribute('fill', _COL_ARROW_DIM); arrowR.setAttribute('filter', 'none');
            } else if (cents <= -_TUNER_ARROW_THR) {
                arrowL.setAttribute('fill', _COL_ARROW_WH);  arrowL.setAttribute('filter', _arrowGlowUrl);
                arrowR.setAttribute('fill', _COL_ARROW_DIM); arrowR.setAttribute('filter', 'none');
            } else if (cents >= _TUNER_ARROW_THR) {
                arrowL.setAttribute('fill', _COL_ARROW_DIM); arrowL.setAttribute('filter', 'none');
                arrowR.setAttribute('fill', _COL_ARROW_WH);  arrowR.setAttribute('filter', _arrowGlowUrl);
            } else {
                arrowL.setAttribute('fill', _COL_ARROW_WH);  arrowL.setAttribute('filter', _arrowGlowUrl);
                arrowR.setAttribute('fill', _COL_ARROW_WH);  arrowR.setAttribute('filter', _arrowGlowUrl);
            }

            // Note display
            if (hasNote) {
                noteLetter.textContent     = note.charAt(0);
                noteAccidental.textContent = note.slice(1);
            } else {
                noteLetter.textContent     = '-';
                noteAccidental.textContent = '';
            }

            // Octave display — show target octave in auto/manual, detected octave in free
            if (hasNote) {
                if ((_currentMode === 'auto' || _currentMode === 'manual') && targetFreq) {
                    octaveEl.textContent = _freqToOctave(targetFreq);
                } else {
                    octaveEl.textContent = _freqToOctave(freq);
                }
            } else {
                octaveEl.textContent = '-';
            }

            // Strobe state — smoothed animation decelerates naturally when _currentCents → 0
            _currentCents = hasNote ? cents : 0;
        }

        // ── Public: destroy ───────────────────────────────────────────
        function destroy() {
            if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
            panel.remove();
        }

        return { update: update, destroy: destroy };
    };
})();
