/**
 * Default (gauge) tuner visualization for the FeedBack tuner plugin.
 *
 * Contract: window._tunerViz_default(container) → { update(note, cents, freq), destroy() }
 *   - note: string | null  (null = no signal)
 *   - cents: number        (deviation from target, −50…+50)
 *   - freq: number         (detected frequency in Hz)
 */
window._tunerViz_default = function (container) {
    'use strict';

    // ── DOM ───────────────────────────────────────────────────────────
    const noteDisplay = document.createElement('div');
    noteDisplay.className = 'my-2 h-16 flex items-center justify-center';

    const noteText = document.createElement('div');
    noteText.className = 'text-5xl font-black text-white';
    noteText.textContent = '--';
    noteDisplay.appendChild(noteText);
    container.appendChild(noteDisplay);

    const freqDisplay = document.createElement('div');
    freqDisplay.className = 'text-xs text-gray-500 mb-3 font-mono text-center w-full';
    freqDisplay.textContent = '0.0 Hz';
    container.appendChild(freqDisplay);

    const gaugeEl = document.createElement('div');
    gaugeEl.className = 'w-full h-2.5 bg-dark-900 border border-gray-800 rounded-full relative overflow-hidden mb-1.5';

    const centerMarker = document.createElement('div');
    centerMarker.className = 'absolute left-1/2 top-0 bottom-0 w-0.5 bg-accent z-10';
    gaugeEl.appendChild(centerMarker);

    const gaugeNeedle = document.createElement('div');
    gaugeNeedle.className = 'absolute left-1/2 top-0 bottom-0 w-1 bg-white transition-all duration-100 ease-out -translate-x-1/2 z-20 shadow-[0_0_8px_rgba(255,255,255,0.5)]';
    gaugeEl.appendChild(gaugeNeedle);
    container.appendChild(gaugeEl);

    const centsDisplay = document.createElement('div');
    centsDisplay.className = 'text-sm font-bold tracking-tight text-center w-full';
    centsDisplay.textContent = '0 cents';
    container.appendChild(centsDisplay);

    // ── Public API ────────────────────────────────────────────────────
    function update(note, cents, freq) {
        if (note === null) {
            noteText.textContent = '--';
            noteText.className = 'text-5xl font-black text-white';
            freqDisplay.textContent = '0.0 Hz';
            centsDisplay.textContent = '0 cents';
            gaugeNeedle.style.left = '50%';
            gaugeNeedle.className = 'absolute left-1/2 top-0 bottom-0 w-1 bg-white transition-all duration-100 ease-out -translate-x-1/2 z-20 shadow-[0_0_8px_rgba(255,255,255,0.5)]';
            return;
        }

        noteText.textContent = note;
        noteText.className = 'text-5xl font-black ' + (Math.abs(cents) < 5 ? 'text-green-400' : 'text-white');

        freqDisplay.textContent = freq.toFixed(1) + ' Hz';
        centsDisplay.textContent = (cents > 0 ? '+' : '') + cents.toFixed(0) + ' cents';

        const gaugeRange = 50;
        const percent = Math.max(0, Math.min(100, 50 + (cents / gaugeRange) * 50));
        gaugeNeedle.style.left = percent + '%';

        if (Math.abs(cents) < 5) {
            gaugeNeedle.className = 'absolute top-0 bottom-0 w-1 bg-green-400 transition-all duration-100 ease-out -translate-x-1/2 z-20 shadow-[0_0_8px_rgba(74,222,128,0.5)]';
        } else {
            gaugeNeedle.className = 'absolute top-0 bottom-0 w-1 bg-white transition-all duration-100 ease-out -translate-x-1/2 z-20 shadow-[0_0_8px_rgba(255,255,255,0.5)]';
        }
    }

    function destroy() {
        noteDisplay.remove();
        freqDisplay.remove();
        gaugeEl.remove();
        centsDisplay.remove();
    }

    return { update, destroy };
};
