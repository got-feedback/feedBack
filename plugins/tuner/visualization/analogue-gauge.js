/**
 * Analogue gauge tuner visualization for the FeedBack tuner plugin.
 *
 * Contract: window['_tunerViz_analogue-gauge'](container) → { update(note, cents, freq), destroy() }
 *   - note: string | null  (null = no signal)
 *   - cents: number        (deviation from target, −50…+50)
 *   - freq: number         (detected frequency in Hz)
 *
 * Layout (vintage analogue instrument panel):
 *   - Off-white panel face
 *   - Full-width black gauge section; frequency drum window centred inside it
 *   - Red SVG needle sweeps over the freq drum window
 *   - Note name drum + lightbulb below the gauge
 */
(function () {
    'use strict';

    // ── Constants ─────────────────────────────────────────────────────
    var _TUNER_LABEL_H = 12;           // px height of each drum label
    var _TUNER_NEEDLE_HALF_SWEEP = 90; // degrees — ±50 cents = horizontal (180° apart)
    var _TUNER_IN_TUNE_THRESHOLD = 2;
    var _TUNER_STRIP_START_MIDI = 14;  // ~18 Hz — covers 20 Hz minimum
    var _TUNER_STRIP_END_MIDI = 84;    // ~1047 Hz C6
    var _TUNER_NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    var _TUNER_NOTE_FLAT  = ['C','Db','D','Eb', 'E','F','Gb','G','Ab','A','Bb', 'B'];
    // SVG gauge geometry — viewBox 200 × 110, pivot at bottom-centre
    // R=95 keeps arc endpoints ~5 SVG units from the viewBox edges to prevent clipping
    var _SVG_CX = 100, _SVG_CY = 110, _SVG_R = 95, _SVG_NEEDLE_LEN = 88;

    window['_tunerViz_analogue-gauge'] = function (container) {
        'use strict';

        var svgNS = 'http://www.w3.org/2000/svg';

        function _midiToFreq(m) { return Math.pow(2, (m - 69) / 12) * 440; }

        // ── Panel (off-white, vintage) ────────────────────────────────
        var panel = document.createElement('div');
        panel.className = 'w-full relative flex flex-col items-center gap-2 p-3 rounded-lg';
        panel.style.backgroundColor = '#e8e0cc';
        panel.style.border = '2px solid #b0a080';

        // ── AUTO lamp (top-left; lit in free-tune mode) ──────────────
        var autoWrap = document.createElement('div');
        autoWrap.style.position = 'absolute';
        autoWrap.style.top = '8px';
        autoWrap.style.left = '10px';
        autoWrap.style.zIndex = '20';
        autoWrap.style.display = 'flex';
        autoWrap.style.alignItems = 'center';
        autoWrap.style.gap = '4px';

        var autoLamp = document.createElement('div');
        autoLamp.style.width = '8px';
        autoLamp.style.height = '8px';
        autoLamp.style.backgroundColor = '#2a0000';
        autoLamp.style.border = '1px solid #5a2020';
        autoLamp.style.flexShrink = '0';

        var autoLabel = document.createElement('span');
        autoLabel.style.fontSize = '9px';
        autoLabel.style.fontFamily = 'monospace';
        autoLabel.style.fontWeight = 'bold';
        autoLabel.style.color = '#888';
        autoLabel.textContent = 'AUTO';

        autoWrap.appendChild(autoLamp);
        autoWrap.appendChild(autoLabel);
        panel.appendChild(autoWrap);

        // ── A=440 label (top-right) ───────────────────────────────────
        var refLabel = document.createElement('span');
        refLabel.style.position = 'absolute';
        refLabel.style.top = '8px';
        refLabel.style.right = '10px';
        refLabel.style.zIndex = '20';
        refLabel.style.fontSize = '9px';
        refLabel.style.fontFamily = 'monospace';
        refLabel.style.fontWeight = 'bold';
        refLabel.style.color = '#888';
        refLabel.textContent = 'A=440';
        panel.appendChild(refLabel);

        // ── Gauge section (full-width, black face) ────────────────────
        var gaugeFace = document.createElement('div');
        gaugeFace.className = 'w-full relative';
        gaugeFace.style.backgroundColor = '#e8e0cc';
        gaugeFace.style.height = '95px'; // matches cropped viewBox height (110-15)

        // Frequency drum window — centred inside the gauge, behind the needle
        var freqWindow = document.createElement('div');
        freqWindow.style.position = 'absolute';
        freqWindow.style.overflow = 'hidden';
        freqWindow.style.backgroundColor = '#fff';
        freqWindow.style.border = '1px solid #bbb';
        freqWindow.style.width = '104px';
        freqWindow.style.height = (_TUNER_LABEL_H * 2) + 'px';
        freqWindow.style.left = 'calc(50% - 52px)';
        freqWindow.style.top = '39px'; // half needle from pivot: 95 - 88/2 - 24/2 = 39
        freqWindow.style.zIndex = '1';
        // Inset shadows top & bottom → suggests a curved drum surface receding at the edges.
        // Top is shorter/lighter, bottom taller/darker — reads as a drum lit from above.
        freqWindow.style.boxShadow = 'inset 0 4px 5px -4px rgba(0,0,0,0.35), inset 0 -7px 7px -4px rgba(0,0,0,0.55)';

        var freqStrip = document.createElement('div');
        freqStrip.style.position = 'absolute';
        freqStrip.style.width = '100%';

        // "---" is index 0; actual notes start at index 1
        function _makeDrumLabel(text) {
            var el = document.createElement('div');
            el.style.height = _TUNER_LABEL_H + 'px';
            el.style.display = 'flex';
            el.style.alignItems = 'center';
            el.style.justifyContent = 'center';
            el.style.userSelect = 'none';
            el.textContent = text;
            return el;
        }
        var fIdleLabel = _makeDrumLabel('---');
        fIdleLabel.style.fontSize = '11px';
        fIdleLabel.style.fontFamily = 'monospace';
        fIdleLabel.style.fontWeight = 'bold';
        fIdleLabel.style.color = '#111';
        freqStrip.appendChild(fIdleLabel);
        freqStrip.appendChild(_makeDrumLabel('')); // separator: keeps real labels out of view at idle

        for (var fm = _TUNER_STRIP_START_MIDI; fm <= _TUNER_STRIP_END_MIDI; fm++) {
            var fLabel = _makeDrumLabel(_midiToFreq(fm).toFixed(1) + ' Hz');
            fLabel.style.fontSize = '11px';
            fLabel.style.fontFamily = 'monospace';
            fLabel.style.fontWeight = 'bold';
            fLabel.style.color = '#111';
            freqStrip.appendChild(fLabel);
        }
        freqWindow.appendChild(freqStrip);
        gaugeFace.appendChild(freqWindow);

        // SVG — arc, tick marks, needle, pivot (z above freq window)
        var svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('viewBox', '0 15 200 95'); // crop 15px dead space above arc top
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.style.position = 'absolute';
        svg.style.top = '0';
        svg.style.left = '0';
        svg.style.width = '100%';
        svg.style.height = '100%';
        svg.style.zIndex = '2';
        svg.style.overflow = 'visible'; // prevent viewBox from clipping arc edges

        // Arc: R=95 keeps endpoints ~5 SVG units from the viewBox edges
        var arcPath = document.createElementNS(svgNS, 'path');
        arcPath.setAttribute('d', 'M 5 110 A 95 95 0 0 1 195 110');
        arcPath.setAttribute('fill', 'none');
        arcPath.setAttribute('stroke', '#222');
        arcPath.setAttribute('stroke-width', '1.5');
        svg.appendChild(arcPath);

        // Tick marks: long every 10 cents, 4 short between each (every 2 cents).
        // 5 outermost marks on each side (|c| >= 42) in red.
        for (var tc = -50; tc <= 50; tc += 2) {
            var isLong  = (tc % 10 === 0);
            var isRed   = Math.abs(tc) >= 42;
            var tLen    = isLong ? 10 : 5;
            var tColor  = isRed ? '#cc2200' : '#222';
            var tWidth  = isLong ? 1.5 : 1;
            var tAngleRad = ((tc / 50) * _TUNER_NEEDLE_HALF_SWEEP - 90) * Math.PI / 180;
            var ttick = document.createElementNS(svgNS, 'line');
            ttick.setAttribute('x1', (_SVG_CX + (_SVG_R - tLen) * Math.cos(tAngleRad)).toFixed(1));
            ttick.setAttribute('y1', (_SVG_CY + (_SVG_R - tLen) * Math.sin(tAngleRad)).toFixed(1));
            ttick.setAttribute('x2', (_SVG_CX + _SVG_R * Math.cos(tAngleRad)).toFixed(1));
            ttick.setAttribute('y2', (_SVG_CY + _SVG_R * Math.sin(tAngleRad)).toFixed(1));
            ttick.setAttribute('stroke', tColor);
            ttick.setAttribute('stroke-width', String(tWidth));
            svg.appendChild(ttick);
        }

        // Inner labels — dominant-baseline="central" so y = vertical centre of text
        [
            { c: -50, text: '-50', extreme: true },
            { c: -30, text: '-30', yOff: -1 },
            { c:   0, text:  '0',  yOff: -1 },
            { c:  30, text: '+30', yOff: -1 },
            { c:  50, text: '+50', extreme: true }
        ].forEach(function (m) {
            var aRad = ((m.c / 50) * _TUNER_NEEDLE_HALF_SWEEP - 90) * Math.PI / 180;
            var lx = (_SVG_CX + 76 * Math.cos(aRad)).toFixed(1);
            // extreme labels: centre at arc baseline (y=_SVG_CY)
            // others: on arc circle at r=76 plus per-label vertical nudge
            var ly = m.extreme
                ? String(_SVG_CY)
                : (_SVG_CY + 76 * Math.sin(aRad) + (m.yOff || 0)).toFixed(1);
            var lbl = document.createElementNS(svgNS, 'text');
            lbl.setAttribute('x', lx);
            lbl.setAttribute('y', ly);
            lbl.setAttribute('text-anchor', 'middle');
            lbl.setAttribute('dominant-baseline', 'central');
            lbl.setAttribute('font-size', '8');
            lbl.setAttribute('font-family', 'monospace');
            lbl.setAttribute('fill', m.extreme ? '#cc2200' : '#555');
            lbl.textContent = m.text;
            svg.appendChild(lbl);
        });

        // Needle line (pivot at SVG bottom-centre; x2/y2 updated in RAF)
        var needleLine = document.createElementNS(svgNS, 'line');
        needleLine.setAttribute('x1', '100');
        needleLine.setAttribute('y1', '110');
        needleLine.setAttribute('x2', '100');
        needleLine.setAttribute('y2', String(110 - _SVG_NEEDLE_LEN)); // initial: 0 cents
        needleLine.setAttribute('stroke', '#cc2200');
        needleLine.setAttribute('stroke-width', '2');
        needleLine.setAttribute('stroke-linecap', 'round');
        svg.appendChild(needleLine);

        // Pivot cap
        var pivotCap = document.createElementNS(svgNS, 'circle');
        pivotCap.setAttribute('cx', '100');
        pivotCap.setAttribute('cy', '110');
        pivotCap.setAttribute('r', '5');
        pivotCap.setAttribute('fill', '#cc2200');
        svg.appendChild(pivotCap);

        gaugeFace.appendChild(svg);
        panel.appendChild(gaugeFace);

        // ── Note drum + lightbulb row (below gauge) ───────────────────
        var noteRow = document.createElement('div');
        noteRow.className = 'w-full relative flex justify-center items-center';

        var noteWindow = document.createElement('div');
        noteWindow.style.position = 'relative';
        noteWindow.style.overflow = 'hidden';
        noteWindow.style.backgroundColor = '#fff';
        noteWindow.style.border = '1px solid #999';
        noteWindow.style.width = '48px';
        noteWindow.style.height = (_TUNER_LABEL_H * 2) + 'px';
        // Inset shadows top & bottom → suggests a curved drum surface receding at the edges.
        // Top is shorter/lighter, bottom taller/darker — reads as a drum lit from above.
        noteWindow.style.boxShadow = 'inset 0 4px 5px -4px rgba(0,0,0,0.35), inset 0 -7px 7px -4px rgba(0,0,0,0.55)';

        var noteStrip = document.createElement('div');
        noteStrip.style.position = 'absolute';
        noteStrip.style.width = '100%';

        var nIdleLabel = _makeDrumLabel('---');
        nIdleLabel.style.fontSize = '10px';
        nIdleLabel.style.fontWeight = 'bold';
        nIdleLabel.style.color = '#111';
        noteStrip.appendChild(nIdleLabel);
        noteStrip.appendChild(_makeDrumLabel('')); // separator

        var _drumLabels = []; // {el, nm} — for flat/sharp relabeling
        for (var nm = _TUNER_STRIP_START_MIDI; nm <= _TUNER_STRIP_END_MIDI; nm++) {
            var nLabel = _makeDrumLabel(_TUNER_NOTE_NAMES[nm % 12]);
            nLabel.style.fontSize = '10px';
            nLabel.style.fontWeight = 'bold';
            nLabel.style.color = '#111';
            noteStrip.appendChild(nLabel);
            _drumLabels.push({ el: nLabel, nm: nm });
        }
        noteWindow.appendChild(noteStrip);

        // Lightbulb — absolutely offset from panel centre so note window stays centred
        // noteWindow is 48px wide → bulb left edge = 50% + 24px (half window) + 6px gap
        var bulbEl = document.createElement('div');
        bulbEl.style.position = 'absolute';
        bulbEl.style.left = 'calc(50% + 30px)';
        bulbEl.style.top = '50%';
        bulbEl.style.transform = 'translateY(-50%)';
        bulbEl.style.width = '20px';
        bulbEl.style.height = '20px';
        bulbEl.style.borderRadius = '50%';
        bulbEl.style.backgroundColor = '#2a1010';
        bulbEl.style.border = '2px solid #4a2020';
        noteRow.appendChild(noteWindow);
        noteRow.appendChild(bulbEl);

        panel.appendChild(noteRow);
        container.appendChild(panel);

        // ── State ─────────────────────────────────────────────────────
        // Must be defined before currentDrumY initialisation (var hoisting trap)
        var _IDLE_DRUM_Y = _TUNER_LABEL_H * 0.5; // centres --- label (index 0) in window
        var currentDrumY = _IDLE_DRUM_Y, targetDrumY = _IDLE_DRUM_Y;
        var _lastUseFlats = false;
        var currentAngle = 0, targetAngle = 0;
        var lastTime = performance.now();
        var rafId = null;

        // ── Needle SVG update ─────────────────────────────────────────
        function _setNeedle(angleDeg) {
            var rad = (angleDeg - 90) * Math.PI / 180;
            needleLine.setAttribute('x2', (_SVG_CX + _SVG_NEEDLE_LEN * Math.cos(rad)).toFixed(1));
            needleLine.setAttribute('y2', (_SVG_CY + _SVG_NEEDLE_LEN * Math.sin(rad)).toFixed(1));
        }

        // ── Drum position ─────────────────────────────────────────────

        function _computeDrumY(freq, cents) {
            if (!freq || freq <= 0) return _IDLE_DRUM_Y;
            var midi = 69 + 12 * Math.log2(freq / 440);
            var targetMidi = midi - cents / 100;
            var clamped = Math.max(-50, Math.min(50, cents));
            // +2: index 0 = ---, index 1 = separator, index 2+ = real notes
            var idx = Math.max(2, Math.min(_TUNER_STRIP_END_MIDI - _TUNER_STRIP_START_MIDI + 2, Math.round(targetMidi) - _TUNER_STRIP_START_MIDI + 2));
            return _TUNER_LABEL_H * (0.5 - idx) - (clamped / 50) * (_TUNER_LABEL_H / 2);
        }

        // ── Animation loop ────────────────────────────────────────────
        function _animate() {
            var now = performance.now();
            var dt = Math.min((now - lastTime) / 1000, 0.1);
            lastTime = now;
            var lf = 1 - Math.exp(-10 * dt);

            currentDrumY += (targetDrumY - currentDrumY) * lf;
            freqStrip.style.transform = 'translateY(' + currentDrumY + 'px)';
            noteStrip.style.transform = 'translateY(' + currentDrumY + 'px)';

            currentAngle += (targetAngle - currentAngle) * lf;
            _setNeedle(currentAngle);

            rafId = requestAnimationFrame(_animate);
        }

        rafId = requestAnimationFrame(_animate);

        // ── Public API ────────────────────────────────────────────────
        function _setAutoLamp(lit) {
            autoLamp.style.backgroundColor = lit ? '#cc2200' : '#2a0000';
            autoLamp.style.border = lit ? '1px solid #ff4422' : '1px solid #5a2020';
            autoLamp.style.boxShadow = lit ? '0 0 5px 2px rgba(200,50,0,0.7)' : 'none';
        }

        function update(note, cents, freq, mode, targetFreq, referencePitch, useFlats) {
            if (typeof referencePitch === 'number' && referencePitch > 0) {
                refLabel.textContent = 'A=' + Math.round(referencePitch);
            }
            var wantFlats = !!useFlats;
            if (wantFlats !== _lastUseFlats) {
                _lastUseFlats = wantFlats;
                var names = wantFlats ? _TUNER_NOTE_FLAT : _TUNER_NOTE_NAMES;
                for (var _di = 0; _di < _drumLabels.length; _di++) {
                    _drumLabels[_di].el.textContent = names[_drumLabels[_di].nm % 12];
                }
            }
            // AUTO lamp: free → always lit; auto → lit on signal; manual/unknown → off
            if (mode === 'free') {
                _setAutoLamp(true);
            } else if (mode === 'auto') {
                _setAutoLamp(note !== null);
            } else {
                _setAutoLamp(false);
            }

            if (note === null) {
                targetDrumY = _IDLE_DRUM_Y;
                targetAngle = 0;
                bulbEl.style.backgroundColor = '#2a1010';
                bulbEl.style.border = '2px solid #4a2020';
                bulbEl.style.boxShadow = 'none';
                return;
            }

            targetDrumY = _computeDrumY(freq, cents);

            targetAngle = (Math.max(-50, Math.min(50, cents)) / 50) * _TUNER_NEEDLE_HALF_SWEEP;

            if (Math.abs(cents) <= _TUNER_IN_TUNE_THRESHOLD) {
                bulbEl.style.backgroundColor = '#cc3300';
                bulbEl.style.border = '2px solid #ff5522';
                bulbEl.style.boxShadow = '0 0 10px 4px rgba(200,50,0,0.85)';
            } else {
                bulbEl.style.backgroundColor = '#2a1010';
                bulbEl.style.border = '2px solid #4a2020';
                bulbEl.style.boxShadow = 'none';
            }
        }

        function destroy() {
            if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
            panel.remove();
        }

        return { update: update, destroy: destroy };
    };
})();
