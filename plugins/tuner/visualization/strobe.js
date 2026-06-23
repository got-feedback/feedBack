/**
 * Strobe tuner visualization for the FeedBack tuner plugin.
 *
 * Contract: window._tunerViz_strobe(container) → { update(note, cents, freq), destroy() }
 *   - note: string | null  (null = no signal)
 *   - cents: number        (deviation from target, −50…+50)
 *   - freq: number         (detected frequency in Hz)
 */
window._tunerViz_strobe = function (container) {
    'use strict';

    // ── LCD segment map ───────────────────────────────────────────────
    const _SEGMENT_MAP = {
        'A': [1,1,1,1,0,0,1,1,1,1,0,0,0,0,0,0],
        'B': [1,1,1,1,1,1,0,0,0,1,1,1,0,0,0,0],
        'C': [1,1,0,0,1,1,1,1,0,0,0,0,0,0,0,0],
        'D': [1,1,1,1,1,1,0,0,0,0,1,1,0,0,0,0],
        'E': [1,1,0,0,1,1,1,1,1,0,0,0,0,0,0,0],
        'F': [1,1,0,0,0,0,1,1,1,0,0,0,0,0,0,0],
        'G': [1,1,0,1,1,1,1,1,0,1,0,0,0,0,0,0],
        '-': [0,0,0,0,0,0,0,0,1,1,0,0,0,0,0,0],
        ' ': [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    };

    // Subtle glow for lit LCD elements; currentColor matches each element's own color
    const _LIT_GLOW = 'drop-shadow(0 0 4px currentColor)';

    function _createLCDDigit() {
        const digit = document.createElement('div');
        digit.className = 'segment-digit relative w-12 h-16 flex-shrink-0';
        // Glow rides on the rendered segments; unlit ones (opacity 0.05) stay dark
        digit.style.filter = _LIT_GLOW;
        const seg = 'absolute bg-current transition-opacity duration-150 rounded-sm';
        digit.innerHTML = `
            <div class="${seg} top-0 left-0.5 w-[calc(50%-1px)] h-2 rounded-tl-md" data-seg="0"></div>
            <div class="${seg} top-0 right-0.5 w-[calc(50%-1px)] h-2 rounded-tr-md" data-seg="1"></div>
            <div class="${seg} bottom-0 right-0.5 w-[calc(50%-1px)] h-2 rounded-br-md" data-seg="4"></div>
            <div class="${seg} bottom-0 left-0.5 w-[calc(50%-1px)] h-2 rounded-bl-md" data-seg="5"></div>
            <div class="${seg} top-1 left-0 w-2 h-[calc(50%-1.5px)]" data-seg="7"></div>
            <div class="${seg} bottom-1 left-0 w-2 h-[calc(50%-1.5px)]" data-seg="6"></div>
            <div class="${seg} top-1 right-0 w-2 h-[calc(50%-1.5px)]" data-seg="2"></div>
            <div class="${seg} bottom-1 right-0 w-2 h-[calc(50%-1.5px)]" data-seg="3"></div>
            <div class="${seg} top-1/2 left-1.5 w-[calc(50%-2px)] h-2 -translate-y-1/2" data-seg="8"></div>
            <div class="${seg} top-1/2 right-1.5 w-[calc(50%-2px)] h-2 -translate-y-1/2" data-seg="9"></div>
            <div class="${seg} top-1.5 left-1/2 w-2 h-[calc(50%-2.5px)] -translate-x-1/2" data-seg="10"></div>
            <div class="${seg} bottom-1.5 left-1/2 w-2 h-[calc(50%-2.5px)] -translate-x-1/2" data-seg="11"></div>
            <svg class="absolute inset-0 w-full h-full pointer-events-none overflow-visible" viewBox="0 0 48 64">
                <line x1="10" y1="10" x2="22" y2="30" stroke="currentColor" stroke-width="6" stroke-linecap="round" class="transition-opacity duration-150" style="opacity:0.05" data-seg="12"/>
                <line x1="38" y1="10" x2="26" y2="30" stroke="currentColor" stroke-width="6" stroke-linecap="round" class="transition-opacity duration-150" style="opacity:0.05" data-seg="13"/>
                <line x1="10" y1="54" x2="22" y2="34" stroke="currentColor" stroke-width="6" stroke-linecap="round" class="transition-opacity duration-150" style="opacity:0.05" data-seg="14"/>
                <line x1="38" y1="54" x2="26" y2="34" stroke="currentColor" stroke-width="6" stroke-linecap="round" class="transition-opacity duration-150" style="opacity:0.05" data-seg="15"/>
            </svg>
        `;
        return digit;
    }

    function _updateSegmentDigit(el, char) {
        const active = _SEGMENT_MAP[char.toUpperCase()] || _SEGMENT_MAP[' '];
        el.querySelectorAll('[data-seg]').forEach((s) => {
            s.style.opacity = active[parseInt(s.dataset.seg)] ? '1' : '0.05';
        });
    }

    // ── DOM ─────────────────────────────────────────────────────────
    const wrap = document.createElement('div');
    wrap.className = 'w-full h-32 bg-dark-900 border border-gray-800 rounded-lg relative overflow-hidden mb-3 flex flex-col items-center justify-end pb-4';

    const noteSegmented = document.createElement('div');
    noteSegmented.className = 'flex items-center justify-center gap-2 text-accent z-30';

    const spacer = document.createElement('div');
    spacer.className = 'w-8 flex-shrink-0';
    noteSegmented.appendChild(spacer);

    const digit = _createLCDDigit();
    noteSegmented.appendChild(digit);

    const sharp = document.createElement('div');
    sharp.className = 'relative w-8 h-16 flex-shrink-0';
    sharp.innerHTML = `
        <div class="sharp-segments absolute inset-0 opacity-5 transition-opacity duration-150">
            <div class="absolute top-[30%] left-0 right-0 h-2.5 bg-current -rotate-12 rounded-full"></div>
            <div class="absolute bottom-[30%] left-0 right-0 h-2.5 bg-current -rotate-12 rounded-full"></div>
            <div class="absolute top-0 bottom-0 left-[30%] w-2.5 bg-current rotate-12 rounded-full"></div>
            <div class="absolute top-0 bottom-0 right-[30%] w-2.5 bg-current rotate-12 rounded-full"></div>
        </div>
    `;
    const sharpSegsEl = sharp.querySelector('.sharp-segments');
    const flatSegEl = document.createElement('div');
    flatSegEl.style.cssText = 'position:absolute;inset:0;display:none;align-items:flex-end;justify-content:center;font-size:2.4rem;font-weight:900;line-height:1;color:currentColor;transition:opacity 0.15s;';
    flatSegEl.textContent = '♭';
    sharp.appendChild(flatSegEl);
    noteSegmented.appendChild(sharp);
    wrap.appendChild(noteSegmented);

    const scanlines = document.createElement('div');
    scanlines.className = 'absolute inset-0 z-40 pointer-events-none opacity-20';
    scanlines.style.backgroundImage = 'repeating-linear-gradient(90deg,#000 0px,#000 1px,transparent 1px,transparent 3px),repeating-linear-gradient(0deg,#000 0px,#000 1px,transparent 1px,transparent 3px)';
    wrap.appendChild(scanlines);

    const stripeGrad = 'linear-gradient(90deg,currentColor 0%,currentColor 45%,transparent 45%,transparent 100%)';
    const strobeEl = document.createElement('div');
    strobeEl.className = 'absolute top-0 left-0 w-full h-full text-accent';
    strobeEl.style.cssText = `transition:opacity 0.3s ease,filter 0.3s ease;background-image:${stripeGrad},${stripeGrad};background-size:40px 15%,80px 15%;background-position:0 5%,0 21%;background-repeat:repeat-x;opacity:0`;
    // Strobe glow scales with its brightness state (set in update); none while hidden
    const _STROBE_GLOW_IN_TUNE = 'drop-shadow(0 0 3px currentColor)';
    const _STROBE_GLOW_OUT     = 'drop-shadow(0 0 1px currentColor)';
    wrap.appendChild(strobeEl);

    container.appendChild(wrap);

    // ── State ─────────────────────────────────────────────────────────
    let strobePhase = 0;
    let smoothedCents = 0;
    let currentCents = 0;
    let strobeActive = false;
    let lastAnimateTime = performance.now();
    let lastSignalTime = performance.now();
    let rafId = null;

    function _animate() {
        const now = performance.now();
        let dt = (now - lastAnimateTime) / 1000;
        if (dt > 0.1) dt = 0.016;
        lastAnimateTime = now;

        const lerpFactor = 1 - Math.exp(-10 * dt);
        smoothedCents = smoothedCents * (1 - lerpFactor) + currentCents * lerpFactor;

        const signalTimeout = (now - lastSignalTime) > 1000;
        if (strobeActive && !signalTimeout) {
            const absCents = Math.min(100, Math.abs(smoothedCents));
            const maxSpeed = 2500;
            const base = 10;
            let speed = maxSpeed * (Math.pow(base, absCents / 100) - 1) / (base - 1);
            if (smoothedCents < 0) speed = -speed;

            strobePhase = ((strobePhase + speed * dt) % 80 + 80) % 80;
            strobeEl.style.backgroundPosition = `${strobePhase}px 5%,${strobePhase}px 21%`;
        } else if (signalTimeout && strobeActive) {
            strobeActive = false;
            strobeEl.style.opacity = '0';
        }

        rafId = requestAnimationFrame(_animate);
    }

    rafId = requestAnimationFrame(_animate);

    // ── Public API ────────────────────────────────────────────────────
    function _setAccidental(acc) {
        if (acc === '#') {
            sharpSegsEl.style.opacity = '1';
            sharpSegsEl.style.filter  = _LIT_GLOW;
            flatSegEl.style.display   = 'none';
        } else if (acc === 'b') {
            sharpSegsEl.style.opacity = '0.05';
            sharpSegsEl.style.filter  = 'none';
            flatSegEl.style.display   = 'flex';
            flatSegEl.style.filter    = _LIT_GLOW;
        } else {
            sharpSegsEl.style.opacity = '0.05';
            sharpSegsEl.style.filter  = 'none';
            flatSegEl.style.display   = 'none';
        }
    }

    function update(note, cents, freq) {
        if (note === null) {
            strobeActive = false;
            strobeEl.style.opacity = '0';
            _updateSegmentDigit(digit, '-');
            _setAccidental('');
            currentCents = 0;
            return;
        }

        lastSignalTime = performance.now();
        strobeActive = true;
        currentCents = cents;

        _updateSegmentDigit(digit, note[0]);
        _setAccidental(note.length > 1 ? note[1] : '');

        strobeEl.style.backgroundImage = `${stripeGrad},${stripeGrad}`;
        strobeEl.style.backgroundSize = '40px 15%,80px 15%';
        strobeEl.style.backgroundPosition = `${strobePhase}px 5%,${strobePhase}px 21%`;
        const inTune = Math.abs(cents) < 5;
        strobeEl.style.opacity = inTune ? '1' : '0.6';
        strobeEl.style.filter = inTune ? _STROBE_GLOW_IN_TUNE : _STROBE_GLOW_OUT;
    }

    function destroy() {
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        wrap.remove();
    }

    return { update, destroy };
};
