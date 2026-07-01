window._tunerUI = function(state, actions) {
    const _AUTO_TARGET_HYSTERESIS_CENTS = 40;
    let _lastAutoTargetFreq = null;
    let _lastTuningRef = null;

    // Octave-aware nearest-string match. YIN frequently reports a sub-octave on
    // low strings (D1 instead of D2) and a common sub-harmonic on polyphonic
    // plucks (D+G together → G0), which a raw-distance match snaps to the wrong
    // (lower) string. Fold the detected frequency into each candidate string's
    // octave before measuring distance so an octave-off reading still resolves
    // to the right string. Ties — a tuning with the same pitch class in two
    // octaves, e.g. guitar E2/E4 — resolve to the smallest octave shift, i.e.
    // the octave actually being played. Returns the matched string frequency
    // and the detected frequency folded into that string's octave.
    function _matchString(detected, strings) {
        let bestFreq = null, bestResidual = Infinity, bestShift = Infinity;
        for (const f of strings) {
            if (!Number.isFinite(f) || f <= 0) continue; // skip malformed tuning entries
            const shift = Math.round(Math.log2(f / detected));
            const corrected = detected * Math.pow(2, shift);
            const residual = Math.abs(Math.log2(corrected / f)) * 1200;
            if (residual < bestResidual - 1
                || (Math.abs(residual - bestResidual) <= 1 && Math.abs(shift) < bestShift)) {
                bestFreq = f; bestResidual = residual; bestShift = Math.abs(shift);
            }
        }
        return bestFreq; // null when no usable string frequency exists
    }

    // Fold a detected frequency into the same octave as a known target, so cents
    // and the displayed Hz reflect deviation within the octave rather than a
    // ±1200 swing when the detector reports the wrong octave.
    function _foldToOctaveOf(detected, target) {
        return detected * Math.pow(2, Math.round(Math.log2(target / detected)));
    }

    const _INSTRUMENT_DISPLAY = {
        'guitar-6': 'Guitar (6)', 'guitar-7': 'Guitar (7)', 'guitar-8': 'Guitar (8)',
        'bass-4': 'Bass (4)', 'bass-5': 'Bass (5)',
    };

    function _freqsEqual(a, b) {
        if (!a || !b || a.length !== b.length) return false;
        return a.every(function(f, i) { return Math.round(f * 100) === Math.round(b[i] * 100); });
    }

    function _tuningAlreadyKnown(freqs) {
        if (!freqs || !freqs.length) return false;
        const instrument = state.selectedInstrument;
        const known = (state._allTunings && state._allTunings[instrument]) || {};
        for (var name in known) {
            if (_freqsEqual(freqs, known[name])) return true;
        }
        return false;
    }

    function _updateInstrumentDisplay() {
        if (state._instrumentSentinel) {
            state._instrumentSentinel.textContent = _INSTRUMENT_DISPLAY[state.selectedInstrument] || state.selectedInstrument;
            if (state.instrumentSelect) state.instrumentSelect.value = '__display__';
        }
    }

    function _syncStringHighlight(targetFreq) {
        if (!state.stringNoteContainer) return;
        Array.from(state.stringNoteContainer.children).forEach(btn => {
            const match = targetFreq !== null && Math.abs(parseFloat(btn.dataset.freq) - targetFreq) < 0.1;
            btn.className = match
                ? 'flex-1 py-1.5 text-xs font-bold rounded bg-accent text-white border border-accent transition-colors'
                : 'flex-1 py-1.5 text-xs font-bold rounded bg-fb-cardMuted text-fb-textDim border border-fb-border/50 hover:border-fb-border transition-colors';
        });
    }

    function _syncActiveStringFromFreq(targetFreq, isManual) {
        if (!state.stringNoteContainer) return;
        Array.from(state.stringNoteContainer.children).forEach(btn => {
            const match = Math.abs(parseFloat(btn.dataset.freq) - targetFreq) < 0.1;
            if (match) {
                btn.className = isManual
                    ? 'flex-1 py-1.5 text-xs font-bold rounded bg-accent text-white border border-accent transition-colors'
                    : 'flex-1 py-1.5 text-xs font-bold rounded bg-fb-cardMuted text-accent border border-accent transition-colors';
            } else {
                btn.className = 'flex-1 py-1.5 text-xs font-bold rounded bg-fb-cardMuted text-fb-textDim border border-fb-border/50 hover:border-fb-border transition-colors';
            }
        });
    }

    function _updateSaveAsCustomVisibility() {
        if (!state.saveAsCustomContainer) return;
        const show = state.selectedTuningName === '_current'
            && state.selectedTuning
            && state.selectedTuning.length > 0
            && !_tuningAlreadyKnown(state.selectedTuning);
        if (show) {
            state.saveAsCustomContainer.classList.remove('hidden');
        } else {
            state.saveAsCustomContainer.classList.add('hidden');
            const inp = state.saveAsCustomContainer.querySelector('.tuner-save-inline');
            if (inp) inp.remove();
        }
    }

    function _showSaveAsCustomInput() {
        if (state.saveAsCustomContainer.querySelector('.tuner-save-inline')) return;

        const labelBtn = state.saveAsCustomContainer.querySelector('.tuner-save-label');
        if (labelBtn) labelBtn.classList.add('hidden');

        const inline = document.createElement('div');
        inline.className = 'tuner-save-inline flex gap-2 w-full';

        const suggestedName = (state.currentSongOffsets && window._tunerUtils)
            ? (window._tunerUtils.getTuningName(state.currentSongOffsets) || 'Custom Tuning')
            : 'Custom Tuning';

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = suggestedName;
        nameInput.className = 'flex-1 bg-fb-cardMuted border border-fb-border/50 rounded px-2 py-1 text-xs text-fb-text outline-none focus:border-accent';

        const confirmBtn = document.createElement('button');
        confirmBtn.textContent = 'Save';
        confirmBtn.className = 'bg-accent/20 hover:bg-accent/30 border border-accent/40 text-accent text-xs px-3 py-1 rounded transition-colors';

        const doSave = async () => {
            const name = nameInput.value.trim();
            if (!name || !state.selectedTuning || state.selectedTuning.length === 0) return;
            const rounded = state.selectedTuning.map(f => Math.round(f * 100) / 100);
            const sc = rounded.length;
            const instrument = (sc === 4 || sc === 5)
                ? (state.currentSongIsBass ? 'bass-' + sc : 'guitar-6')
                : (sc === 7 ? 'guitar-7' : sc === 8 ? 'guitar-8' : 'guitar-6');
            try {
                const config = await fetch('/api/plugins/tuner/config').then(r => r.json());
                const custom = config.customTunings || {};
                custom[name] = { instrument, strings: rounded };
                await fetch('/api/plugins/tuner/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ customTunings: custom }),
                });
                state.selectedInstrument = instrument;
                state.selectedTuningName = name;
                state.selectedTuning = rounded;
                _updateInstrumentDisplay();
                await actions.loadConfig();
                state.selectedTuningName = name;
                state.selectedTuning = state.tunings[name] || rounded;
                if (state.tuningSelect) state.tuningSelect.value = name;
                renderStringNotes();
                actions.saveConfig();
                window.feedBack?.emit('tunings:updated');
            } catch (e) {
                console.error('Tuner: Failed to save custom tuning', e);
            }
        };

        confirmBtn.onclick = doSave;
        nameInput.onkeydown = (e) => { if (e.key === 'Enter') doSave(); };

        inline.appendChild(nameInput);
        inline.appendChild(confirmBtn);
        state.saveAsCustomContainer.appendChild(inline);
        nameInput.focus();
        nameInput.select();
    }

    function renderInstrumentOptions() {
        if (!state.instrumentSelect) return;
        state.instrumentSelect.innerHTML = '';

        state._instrumentSentinel = document.createElement('option');
        state._instrumentSentinel.value = '__display__';
        state._instrumentSentinel.textContent = _INSTRUMENT_DISPLAY[state.selectedInstrument] || state.selectedInstrument;
        state._instrumentSentinel.style.display = 'none';
        state.instrumentSelect.appendChild(state._instrumentSentinel);

        const guitarGroup = document.createElement('optgroup');
        guitarGroup.label = 'Guitar';
        [['guitar-6', '6-string'], ['guitar-7', '7-string'], ['guitar-8', '8-string']].forEach(([val, label]) => {
            const opt = document.createElement('option');
            opt.value = val; opt.textContent = label;
            guitarGroup.appendChild(opt);
        });

        const bassGroup = document.createElement('optgroup');
        bassGroup.label = 'Bass';
        [['bass-4', '4-string'], ['bass-5', '5-string']].forEach(([val, label]) => {
            const opt = document.createElement('option');
            opt.value = val; opt.textContent = label;
            bassGroup.appendChild(opt);
        });

        state.instrumentSelect.appendChild(guitarGroup);
        state.instrumentSelect.appendChild(bassGroup);
        state.instrumentSelect.value = '__display__';
    }

    function renderTuningOptions() {
        if (!state.tuningSelect) return;
        state.tuningSelect.innerHTML = '';

        const isPlayer = document.getElementById('player')?.classList.contains('active');
        if (isPlayer && typeof window.highway?.getSongInfo === 'function') {
            const info = window.highway.getSongInfo();
            if (info && info.tuning) {
                const ctx = (typeof window.feedBack?.songTuningContext === 'function')
                    ? window.feedBack.songTuningContext(info)
                    : {
                        stringCount: info.stringCount,
                        arrangement: info.arrangement,
                        arrangement_smart_name: info.arrangement_smart_name,
                    };
                const isBass = (typeof window.feedBack?.isBassArrangement === 'function')
                    ? window.feedBack.isBassArrangement(ctx)
                    : (info.arrangement || '').toLowerCase().includes('bass');
                const sc = (typeof window.feedBack?.effectiveStringCount === 'function')
                    ? window.feedBack.effectiveStringCount(info.tuning, ctx)
                    : (info.stringCount || info.tuning.length);
                const sliced = info.tuning.slice(0, sc);
                const freqs = window._tunerUtils.offsetsToFreqs(sliced, isBass);
                const tName = (typeof window.displayTuningName === 'function')
                    ? window.displayTuningName(null, sliced)
                    : window._tunerUtils.getTuningName(sliced);

                const opt = document.createElement('option');
                opt.value = '_current';
                opt.textContent = `Current Song [${tName || 'Custom Tuning'}]`;
                state.tuningSelect.appendChild(opt);

                if (state.selectedTuningName === '_current') state.selectedTuning = freqs;
            } else if (state.selectedTuningName === '_current') {
                state.selectedTuning = null;
            }
        } else if (state.selectedTuningName === '_current') {
            state.selectedTuning = null;
        }

        const freeTuneOpt = document.createElement('option');
        freeTuneOpt.value = 'free-tune';
        freeTuneOpt.textContent = 'Free Tune';
        state.tuningSelect.appendChild(freeTuneOpt);

        Object.keys(state.tunings).forEach(name => {
            const opt = document.createElement('option');
            opt.value = name; opt.textContent = name;
            state.tuningSelect.appendChild(opt);
        });

        if (state.selectedTuningName) state.tuningSelect.value = state.selectedTuningName;
    }

    function _noteLabelForFreq(f) {
        const midi = window._tunerUtils.freqToMidi(f);
        const rounded = Math.round(midi);
        const name = window._tunerUtils.midiToNote(rounded, state.useFlats);
        const octave = Math.floor(rounded / 12) - 1;
        return name + octave;
    }

    function _noteNameOnly(f) {
        return window._tunerUtils.midiToNote(
            Math.round(window._tunerUtils.freqToMidi(f)),
            state.useFlats
        );
    }

    function _stringOrdinal(n) {
        const v = n % 100;
        if (v >= 11 && v <= 13) return n + 'th';
        const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
        return n + suffix;
    }

    function _stringButtonLabel(index, total, f) {
        if (state.selectedTuningName === '_current') {
            const stringNum = total - index;
            const note = _noteNameOnly(f);
            return {
                text: note,
                title: _stringOrdinal(stringNum) + ' string: ' + _noteLabelForFreq(f),
            };
        }
        return { text: _noteLabelForFreq(f), title: '' };
    }

    function _syncStringOrderHelp(total) {
        if (!state.stringOrderHelpContainer) return;
        const show = state.selectedTuningName === '_current'
            && state.selectedTuning
            && state.selectedTuning.length > 0;
        if (!show) {
            state.stringOrderHelpContainer.classList.add('hidden');
            state.stringOrderHelpContainer.innerHTML = '';
            return;
        }
        const count = total || state.selectedTuning.length;
        const notes = state.selectedTuning.map((f) => _noteNameOnly(f)).join(' ');
        state.stringOrderHelpContainer.classList.remove('hidden');
        state.stringOrderHelpContainer.innerHTML =
            '<div class="text-fb-textDim">Tune low-to-high: <span class="text-fb-text font-semibold tracking-wide">' + notes + '</span></div>'
            + '<div class="text-fb-textDim/70 mt-0.5">' + _stringOrdinal(count) + ' string → 1st string</div>';
    }

    function renderStringNotes() {
        if (!state.stringNoteContainer) return;
        state.stringNoteContainer.innerHTML = '';
        if (!state.selectedTuning || state.selectedTuning.length === 0) {
            _syncStringOrderHelp(0);
            return;
        }

        const total = state.selectedTuning.length;
        state.selectedTuning.forEach((f, index) => {
            const btn = document.createElement('button');
            btn.dataset.freq = f;
            btn.className = 'flex-1 py-1.5 text-xs font-bold rounded bg-fb-cardMuted text-fb-textDim border border-fb-border/50 hover:border-fb-border transition-colors';
            const label = _stringButtonLabel(index, total, f);
            btn.textContent = label.text;
            if (label.title) btn.title = label.title;
            btn.onclick = () => {
                state.manualTargetFreq = state.manualTargetFreq === f ? null : f;
                _syncStringHighlight(state.manualTargetFreq);
            };
            state.stringNoteContainer.appendChild(btn);
        });
        _syncStringOrderHelp(total);
    }

    function updateUI(result) {
        const { smoothedFreq, rms, hasSignal } = result;
        const vizMode = state.manualTargetFreq ? 'manual'
            : (state.freeTune || !(state.selectedTuning && state.selectedTuning.length > 0) ? 'free' : 'auto');

        // Treat null / non-finite / non-positive as no-signal. A 0, NaN or
        // negative frequency would otherwise propagate through log2/division
        // below into NaN cents and a garbage readout.
        const referencePitch = state.referencePitch || 440;
        if (smoothedFreq === null || !Number.isFinite(smoothedFreq) || smoothedFreq <= 0) {
            _lastAutoTargetFreq = null;
            if (state.activeViz) state.activeViz.update(null, 0, 0, vizMode, null, referencePitch);
            _syncStringHighlight(state.manualTargetFreq);
            if (window.feedBack && window.feedBack.emit) {
                window.feedBack.emit('tuner:frame', { note: null, cents: 0, freq: 0, hasSignal: false });
            }
            return;
        }

        // Reset the committed target when the tuning selection changes.
        if (state.selectedTuning !== _lastTuningRef) {
            _lastAutoTargetFreq = null;
            _lastTuningRef = state.selectedTuning;
        }

        let targetFreq, isManual = false, displayFreq = smoothedFreq;
        if (state.manualTargetFreq) {
            targetFreq = state.manualTargetFreq;
            isManual = true;
        } else if (!state.freeTune && state.selectedTuning && state.selectedTuning.length > 0
                   && _matchString(smoothedFreq, state.selectedTuning) !== null) {
            let nearest = _matchString(smoothedFreq, state.selectedTuning);
            // Hysteresis: once committed to a string, only switch when the new
            // match is clearly closer (≥40 cents), so a pluck that lands between
            // two strings can't flicker. Octave-aware residuals keep an octave
            // error from ever masquerading as a different string.
            if (_lastAutoTargetFreq !== null && nearest !== _lastAutoTargetFreq) {
                const residualNew = Math.abs(Math.log2(_foldToOctaveOf(smoothedFreq, nearest) / nearest)) * 1200;
                const residualPrev = Math.abs(Math.log2(_foldToOctaveOf(smoothedFreq, _lastAutoTargetFreq) / _lastAutoTargetFreq)) * 1200;
                if (residualPrev - residualNew < _AUTO_TARGET_HYSTERESIS_CENTS) nearest = _lastAutoTargetFreq;
            }
            _lastAutoTargetFreq = nearest;
            targetFreq = nearest;
        } else {
            targetFreq = window._tunerUtils.midiToFreq(Math.round(window._tunerUtils.freqToMidi(smoothedFreq)));
        }

        // Fold the reading into the target's octave so a sub-octave detection
        // (D1 read for a D2 string) shows the right note and real cents.
        if (!isManual && targetFreq) displayFreq = _foldToOctaveOf(smoothedFreq, targetFreq);

        const cents = (window._tunerUtils.freqToMidi(displayFreq) - window._tunerUtils.freqToMidi(targetFreq)) * 100;
        const note = window._tunerUtils.midiToNote(window._tunerUtils.freqToMidi(targetFreq), state.useFlats);

        if (state.activeViz) state.activeViz.update(note, cents, displayFreq, vizMode, targetFreq, referencePitch, state.useFlats);
        if (state.freeTune) _syncStringHighlight(null);
        else _syncActiveStringFromFreq(targetFreq, isManual);
        if (window.feedBack && window.feedBack.emit) {
            window.feedBack.emit('tuner:frame', { note, cents, freq: displayFreq, hasSignal: true });
        }
    }

    function updateFloatingButtonVisibility() {
        const btn = document.getElementById('tuner-toggle-btn');
        if (!btn) return;
        const isPlayer = document.querySelector('.screen.active')?.id === 'player';
        if (!state.showFloatingButton || isPlayer || window.feedBack?.isPlaying) {
            btn.classList.add('hidden');
        } else {
            btn.classList.remove('hidden');
        }
    }

    function updateFloatingButton() {
        const btn = document.getElementById('tuner-toggle-btn');
        if (!btn) return;
        const isHidden = btn.classList.contains('hidden');
        btn.className = state.enabled
            ? 'fixed bottom-5 right-5 px-4 py-2.5 bg-accent/20 hover:bg-accent/30 border border-accent text-accent rounded-xl text-sm transition-all duration-200 active:scale-95 shadow-2xl z-[1001]'
            : 'fixed bottom-5 right-5 px-4 py-2.5 bg-dark-700 hover:bg-dark-500 border border-gray-800 text-gray-300 hover:text-white rounded-xl text-sm transition-all duration-200 active:scale-95 shadow-2xl z-[1001]';
        if (isHidden) btn.classList.add('hidden');
        updateFloatingButtonVisibility();
    }

    function updatePlayerButton() {
        const btn = document.getElementById('btn-tuner-player');
        if (!btn) return;
        btn.className = state.enabled
            ? 'px-3 py-1.5 bg-accent/20 hover:bg-accent/30 border border-accent rounded-lg text-xs text-accent transition'
            : 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-400 transition';
    }

    function showSettings() {
        let panel = state.uiContainer.querySelector('.tuner-settings-panel');
        if (panel) { panel.remove(); return; }

        panel = document.createElement('div');
        panel.className = 'tuner-settings-panel w-full bg-fb-cardMuted border border-fb-border/30 rounded-lg p-3 mb-3 text-xs';
        panel.innerHTML = `
            <div class="mb-2">
                <span class="text-fb-textDim font-semibold uppercase tracking-tighter">Audio Settings</span>
            </div>
            <div class="tuner-mic-section">
                <label class="block text-fb-textDim mb-1">Microphone</label>
                <select class="tuner-device-select w-full bg-fb-cardMuted border border-fb-border/50 rounded px-2 py-1 text-fb-text mb-2 outline-none focus:border-accent">
                    <option value="">Default</option>
                </select>
            </div>
            <div class="tuner-channel-section">
                <label class="block text-fb-textDim mb-1">Input Channel</label>
                <select class="tuner-channel-select w-full bg-fb-cardMuted border border-fb-border/50 rounded px-2 py-1 text-fb-text outline-none focus:border-accent">
                    <option value="mono" ${state.selectedChannel === 'mono' ? 'selected' : ''}>Mono (mix both)</option>
                    <option value="left" ${state.selectedChannel === 'left' ? 'selected' : ''}>Left (Channel 1)</option>
                    <option value="right" ${state.selectedChannel === 'right' ? 'selected' : ''}>Right (Channel 2)</option>
                </select>
            </div>
            <label class="block text-fb-textDim mb-1 mt-2">Visualization</label>
            <select class="tuner-viz-select w-full bg-fb-cardMuted border border-fb-border/50 rounded px-2 py-1 text-fb-text outline-none focus:border-accent">
                <option value="default" ${state.visualizationMode === 'default' ? 'selected' : ''}>Default</option>
                <option value="strobe" ${state.visualizationMode === 'strobe' ? 'selected' : ''}>Strobe</option>
                <option value="analogue-gauge" ${state.visualizationMode === 'analogue-gauge' ? 'selected' : ''}>Analogue Gauge</option>
                <option value="mace-fx-iii" ${state.visualizationMode === 'mace-fx-iii' ? 'selected' : ''}>Mace-Fx III</option>
                <option value="pp-tiny" ${state.visualizationMode === 'pp-tiny' ? 'selected' : ''}>Bender PP-Tiny</option>
                <option value="chef-mt3" ${state.visualizationMode === 'chef-mt3' ? 'selected' : ''}>CHEF MT-3</option>
                <option value="toilet-tuner" ${state.visualizationMode === 'toilet-tuner' ? 'selected' : ''}>Toilet Tuner</option>
            </select>
        `;

        state.uiContainer.insertBefore(panel, state.stringNoteContainer);

        panel.querySelector('.tuner-device-select').onchange = (e) => {
            state.selectedDeviceId = e.target.value;
            actions.saveSettings();
            if (state.enabled) actions.restartAudio();
        };
        panel.querySelector('.tuner-channel-select').onchange = (e) => {
            state.selectedChannel = e.target.value;
            actions.saveSettings();
            if (state.enabled) actions.restartAudio();
        };
        panel.querySelector('.tuner-viz-select').onchange = async (e) => {
            state.visualizationMode = e.target.value;
            await actions.setVisualization(state.visualizationMode);
            actions.saveConfig();
            const vizMode = state.manualTargetFreq ? 'manual' : (state.freeTune || !(state.selectedTuning && state.selectedTuning.length > 0) ? 'free' : 'auto');
            if (state.activeViz) state.activeViz.update(null, 0, 0, vizMode);
        };

        populateDevices(panel);

        if (window._tunerAudio && window._tunerAudio.usingBridge) {
            var micSec = panel.querySelector('.tuner-mic-section');
            var chanSec = panel.querySelector('.tuner-channel-section');
            if (micSec) micSec.classList.add('hidden');
            if (chanSec) chanSec.classList.add('hidden');
        }
    }

    async function populateDevices(panel) {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const sel = panel.querySelector('.tuner-device-select');
            if (!sel) return;
            sel.innerHTML = '<option value="">Default</option>';
            for (const d of devices) {
                if (d.kind !== 'audioinput') continue;
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Input ${d.deviceId.slice(0, 8)}`;
                if (d.deviceId === state.selectedDeviceId) opt.selected = true;
                sel.appendChild(opt);
            }
        } catch (e) { /* permission not yet granted */ }
    }

    function showMicError(e) {
        const name = e?.name || '';
        let msg, hint;
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
            msg = 'Microphone access denied.';
            hint = 'On macOS open System Settings → Privacy &amp; Security → Microphone and enable your browser, then refresh the page.';
        } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
            msg = 'No audio input found.';
            hint = 'Make sure your Real Tone Cable (or other audio input) is plugged in and recognised by macOS (check Audio MIDI Setup).';
        } else if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') {
            msg = 'Could not open the audio device.';
            hint = 'On macOS: (1) open Audio MIDI Setup (Applications → Utilities) and confirm the device appears with a compatible sample rate (44100 or 48000 Hz); (2) check System Settings → Privacy &amp; Security → Microphone — your browser must be listed and enabled; (3) try unplugging and replugging the cable.';
        } else {
            msg = 'Could not access microphone.';
            hint = `Error: ${name || e?.message || 'unknown'}`;
        }
        if (!state.uiContainer) { alert(`Tuner: ${msg}\n${hint.replace(/&amp;/g, '&')}`); return; }
        let errEl = state.uiContainer.querySelector('.tuner-mic-error');
        if (!errEl) {
            errEl = document.createElement('div');
            errEl.className = 'tuner-mic-error relative w-full mt-2 p-3 bg-red-900/40 border border-red-700/60 rounded-lg text-xs text-red-300 leading-relaxed';
            state.uiContainer.appendChild(errEl);
        }
        errEl.innerHTML = `<strong>${msg}</strong><br>${hint}`;
        const dismissBtn = document.createElement('button');
        dismissBtn.className = 'absolute top-1.5 right-2 text-red-400 hover:text-red-200 text-sm font-bold leading-none';
        dismissBtn.textContent = '×';
        dismissBtn.onclick = () => errEl.remove();
        errEl.appendChild(dismissBtn);
        state.uiContainer.classList.remove('hidden');
        state.uiContainer.classList.add('flex');
    }

    function updateFreeTuneUI() {
        if (!state.freeTuneToggle) return;
        const on = state.freeTune;
        state.freeTuneToggle.style.backgroundColor = on ? '#4080e0' : '#334155';
        state.freeTuneToggle.setAttribute('aria-checked', String(on));
        const knob = state.freeTuneToggle.querySelector('span');
        if (knob) knob.style.left = on ? '18px' : '2px';
        if (state.stringNoteContainer) {
            state.stringNoteContainer.style.opacity = on ? '0.35' : '';
            state.stringNoteContainer.style.pointerEvents = on ? 'none' : '';
            state.stringNoteContainer.style.transition = 'opacity 0.15s';
        }
        _syncStringOrderHelp();
    }

    function initUI() {
        if (state.uiContainer) return;

        state.uiContainer = document.createElement('div');
        state.uiContainer.id = 'tuner-plugin-ui';
        state.uiContainer.className = 'fixed w-72 bg-fb-card border border-fb-border/50 rounded-xl p-4 text-white z-[1000] hidden flex-col items-center shadow-2xl backdrop-blur-md';

        const header = document.createElement('div');
        header.className = 'flex justify-center items-center w-full mb-3 relative';

        const title = document.createElement('div');
        title.className = 'font-bold text-xs text-fb-textDim uppercase tracking-wider';
        title.textContent = 'TUNER';
        header.appendChild(title);

        // Explicit close (the panel had no in-box dismiss before; persist mode
        // needs one). Mirrors the settings gear on the opposite side.
        const closeBtn = document.createElement('button');
        closeBtn.className = 'absolute left-0 text-fb-textDim hover:text-fb-text transition-colors text-lg leading-none';
        closeBtn.setAttribute('aria-label', 'Close tuner');
        closeBtn.title = 'Close';
        closeBtn.textContent = '×';
        closeBtn.onclick = () => actions.disable();
        state.closeBtn = closeBtn;
        header.appendChild(closeBtn);

        const settingsBtn = document.createElement('button');
        settingsBtn.className = 'absolute right-0 text-fb-textDim hover:text-fb-text transition-colors';
        settingsBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>`;
        settingsBtn.onclick = showSettings;
        header.appendChild(settingsBtn);
        state.uiContainer.appendChild(header);

        state.stringOrderHelpContainer = document.createElement('div');
        state.stringOrderHelpContainer.className = 'tuner-string-order-help hidden w-full mb-2 text-center text-[10px] leading-snug';
        state.uiContainer.appendChild(state.stringOrderHelpContainer);

        state.stringNoteContainer = document.createElement('div');
        state.stringNoteContainer.className = 'flex justify-between w-full mb-3 gap-1';
        state.uiContainer.appendChild(state.stringNoteContainer);
        renderStringNotes();

        state.saveAsCustomContainer = document.createElement('div');
        state.saveAsCustomContainer.className = 'w-full mb-3 hidden';

        const labelBtn = document.createElement('button');
        labelBtn.className = 'tuner-save-label w-full text-[11px] text-accent/70 hover:text-accent border border-accent/20 hover:border-accent/50 rounded-lg py-1.5 transition-colors';
        labelBtn.textContent = 'Save as Custom Tuning';
        labelBtn.onclick = _showSaveAsCustomInput;
        state.saveAsCustomContainer.appendChild(labelBtn);
        state.uiContainer.appendChild(state.saveAsCustomContainer);

        const freeTuneRow = document.createElement('div');
        freeTuneRow.className = 'flex items-center justify-between w-full mb-3';

        const freeTuneLabel = document.createElement('span');
        freeTuneLabel.className = 'text-xs text-fb-textDim select-none';
        freeTuneLabel.textContent = 'Free Tune';

        const toggleTrack = document.createElement('button');
        toggleTrack.type = 'button';
        toggleTrack.setAttribute('role', 'switch');
        toggleTrack.setAttribute('aria-checked', String(state.freeTune));
        toggleTrack.style.cssText = 'position:relative;width:2.25rem;height:1.25rem;border-radius:9999px;border:none;cursor:pointer;transition:background-color 0.15s;outline:none;flex-shrink:0;background-color:' + (state.freeTune ? '#4080e0' : '#334155');

        const toggleKnob = document.createElement('span');
        toggleKnob.style.cssText = 'position:absolute;top:2px;width:1rem;height:1rem;border-radius:9999px;background:white;transition:left 0.15s;left:' + (state.freeTune ? '18px' : '2px');
        toggleTrack.appendChild(toggleKnob);
        state.freeTuneToggle = toggleTrack;

        toggleTrack.addEventListener('click', () => {
            state.freeTune = !state.freeTune;
            if (state.freeTune) state.manualTargetFreq = null;
            updateFreeTuneUI();
            actions.saveConfig();
        });

        freeTuneRow.appendChild(freeTuneLabel);
        freeTuneRow.appendChild(toggleTrack);
        state.uiContainer.appendChild(freeTuneRow);

        state.vizContainer = document.createElement('div');
        state.vizContainer.className = 'w-full';
        state.uiContainer.appendChild(state.vizContainer);

        // Auto-open nudge's explicit dismiss (hidden unless auto-opened; enable()
        // toggles it). Closes the same way as the × — disable().
        const skipBtn = document.createElement('button');
        skipBtn.className = 'tuner-skip-btn hidden w-full mt-3 text-[11px] text-fb-textDim hover:text-fb-text border border-fb-border/40 hover:border-fb-border/70 rounded-lg py-1.5 transition-colors';
        skipBtn.textContent = 'Skip';
        skipBtn.title = "I've tuned — play the song";
        skipBtn.onclick = () => actions.disable();
        state.skipBtn = skipBtn;
        state.uiContainer.appendChild(skipBtn);

        // Auto-open escape hatch: leave the song entirely instead of committing to
        // the play-now choice — so a gated retune is never a one-way trap. Mirrors
        // Escape (the player's "Back to library" shortcut) and, like Escape, does
        // NOT record a tuning (you're leaving, not asserting you tuned).
        const backBtn = document.createElement('button');
        backBtn.className = 'tuner-back-btn hidden w-full mt-2 text-[11px] text-fb-textDim hover:text-fb-text border border-fb-border/40 hover:border-fb-border/70 rounded-lg py-1.5 transition-colors';
        backBtn.textContent = 'Back to library';
        backBtn.title = 'Leave the song (Esc)';
        backBtn.onclick = () => {
            const exit = window.feedBack && window.feedBack.requestExitSong;
            if (typeof exit === 'function') exit();
            else if (typeof window.requestExitSong === 'function') window.requestExitSong();
        };
        state.backBtn = backBtn;
        state.uiContainer.appendChild(backBtn);

        document.body.appendChild(state.uiContainer);
        state.uiContainer.addEventListener('click', (e) => e.stopPropagation());
    }

    function positionPanel() {
        if (!state.uiContainer) return;
        const isPlayer = document.getElementById('player')?.classList.contains('active');
        const playerEl = document.getElementById('player');
        const wrap = document.getElementById('v3-tuner-wrap');

        // #player is a full-screen overlay (z-index 100) that covers the v3
        // topbar — anchoring the panel to #v3-tuner-wrap hides it underneath.
        if (isPlayer && playerEl) {
            if (state.uiContainer.parentElement !== document.body) {
                document.body.appendChild(state.uiContainer);
            }
            state.uiContainer.className = state.uiContainer.className
                .replace('absolute', 'fixed')
                .replace('right-0', '')
                .replace('top-full', '')
                .trim();
            state.uiContainer.style.cssText = 'top:5rem;right:11rem';
            return;
        }

        if (!wrap) {
            // Non-v3 fallback: fixed bottom-right above the floating button.
            if (state.uiContainer.parentElement !== document.body) document.body.appendChild(state.uiContainer);
            state.uiContainer.className = state.uiContainer.className
                .replace('absolute', 'fixed')
                .replace('right-0', '')
                .replace('top-full', '')
                .trim();
            state.uiContainer.style.cssText = 'bottom:5rem;right:1.25rem';
            return;
        }
        // Move panel into the relative wrapper so right-0 aligns its right edge
        // with the right edge of the badge button, exactly like the instrument panel.
        if (state.uiContainer.parentElement !== wrap) wrap.appendChild(state.uiContainer);
        state.uiContainer.className = state.uiContainer.className
            .replace('fixed', 'absolute')
            .trim();
        state.uiContainer.style.cssText = 'top:100%;right:0;margin-top:8px';
    }

    function addButton() {
        if (document.getElementById('tuner-toggle-btn')) return;

        const btn = document.createElement('button');
        btn.id = 'tuner-toggle-btn';
        btn.textContent = 'Tuner';
        btn.title = 'Open Tuner';
        btn.onclick = window.tuner.toggle;
        document.body.appendChild(btn);
        updateFloatingButton();
        updateFloatingButtonVisibility();

        const handlePlay = () => {
            updateFloatingButtonVisibility();
            // A manually-opened tuner closes when playback starts (you don't tune
            // while playing). An AUTO-opened tuner PERSISTS through the autoplay
            // song:play that immediately follows song entry — that auto-close was
            // the "opens then vanishes ~1s later" flash. It closes via Skip/×/leave.
            if (state.enabled && !state.autoOpened) actions.disable();
        };
        const handleStop = () => updateFloatingButtonVisibility();

        if (window.feedBack) {
            window.feedBack.on('song:play', handlePlay);
            window.feedBack.on('song:pause', handleStop);
            window.feedBack.on('song:ended', handleStop);
            window.feedBack.on('screen:changed', (e) => {
                if (e.detail.id === 'player') { handlePlay(); injectPlayerButton(); }
                else handleStop();
            });

            if (window.feedBack.isPlaying || document.querySelector('.screen.active')?.id === 'player') {
                handlePlay();
                if (document.querySelector('.screen.active')?.id === 'player') injectPlayerButton();
            } else {
                updateFloatingButtonVisibility();
            }
        }
    }

    function injectPlayerButton() {
        // v3: mount into the host's stable plugin-control slot (Plugins rail
        // popover). The legacy `button:last-child` anchor resolves to a NESTED
        // transport button in v3 and would throw on insertBefore; the slot is
        // always present in v3, so that anchor is only used in the classic UI.
        const isV3 = !!(window.feedBack && window.feedBack.uiVersion === 'v3');
        let slot = null;
        if (isV3 && window.feedBack.ui && typeof window.feedBack.ui.playerControlSlot === 'function') {
            try { const _s = window.feedBack.ui.playerControlSlot(); if (_s instanceof Element) slot = _s; }
            catch (_e) { /* host slot API failure → fall back to legacy container */ }
        }
        const controls = slot || document.getElementById('player-controls');
        if (!controls || document.getElementById('btn-tuner-player')) return;

        const btn = document.createElement('button');
        btn.id = 'btn-tuner-player';
        btn.textContent = 'Tuner';
        btn.title = 'Open Tuner';
        btn.onclick = window.tuner.toggle;
        const closeBtn = isV3 ? null : controls.querySelector('button:last-child');
        if (closeBtn) controls.insertBefore(btn, closeBtn);
        else controls.appendChild(btn);
        updatePlayerButton();
    }

    return {
        initUI,
        positionPanel,
        renderInstrumentOptions,
        renderTuningOptions,
        renderStringNotes,
        updateUI,
        updateInstrumentDisplay: _updateInstrumentDisplay,
        updateSaveAsCustomVisibility: _updateSaveAsCustomVisibility,
        updateFreeTuneUI,
        updateFloatingButton,
        updatePlayerButton,
        updateFloatingButtonVisibility,
        showMicError,
        addButton,
        injectPlayerButton,
    };
};
