/*
 * input_setup — per-instrument input-device selection & calibration.
 *
 * Bundled core plugin (constitution P-II vanilla JS). It:
 *  1. supplies a Web-MIDI source provider to the core `midi-input` domain;
 *  2. owns the `input-calibration` capability domain (run / status / inspect);
 *  3. renders the onboarding input-setup wizard (one pass per instrument):
 *       - guitar/bass → pick via `audio-input`, then launch note_detect's
 *         Calibration Wizard (note-detection is a deferred surface — JS API);
 *       - keys/drums  → pick via `midi-input`, then a live "play a note /
 *         hit a pad" confirmation.
 *
 * Idempotent (plugin-runtime-idempotent.v1): re-hydration is a no-op.
 */
(function () {
    'use strict';

    window.feedBack = window.feedBack || {};
    if (window.feedBackInputSetup && window.feedBackInputSetup.version === 1) return;

    const capabilities = window.feedBack.capabilities;
    const DONE_KEY = (inst) => `input_setup.done.${inst}`;
    const INSTRUMENTS = {
        guitar: { label: 'Guitar', mode: 'audio' },
        bass: { label: 'Bass', mode: 'audio' },
        keys: { label: 'Keys / Piano', mode: 'midi' },
        piano: { label: 'Keys / Piano', mode: 'midi' },
        drums: { label: 'Drums', mode: 'midi' },
    };

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function _isDone(inst) { try { return window.localStorage.getItem(DONE_KEY(inst)) === '1'; } catch (_) { return false; } }
    function _markDone(inst, v) { try { if (v) window.localStorage.setItem(DONE_KEY(inst), '1'); else window.localStorage.removeItem(DONE_KEY(inst)); } catch (_) { /* private mode */ } }

    // The Web-MIDI source provider now ships built-in with the core midi-input
    // domain (static/capabilities/midi-input.js), so input_setup is a pure
    // consumer — it just discovers/selects/opens through `window.feedBack.midiInput`.

    // ── audio-input helper (guitar/bass device context) ─────────────────────
    async function _audioSources() {
        if (!capabilities || typeof capabilities.command !== 'function') return { sources: [], selected: null };
        try {
            const r = await capabilities.command('audio-input', 'list-sources', { requester: 'input_setup' });
            const p = (r && r.payload) || {};
            let sources = Array.isArray(p.sources) ? p.sources : [];
            // Exclude MIDI devices some plugins export into audio-input
            // (e.g. keys-highway-3d's pseudonymized 'midi-input-N'): they aren't
            // audio inputs and the cryptic labels confuse this guitar/bass picker.
            sources = sources.filter((s) => s
                && !/midi/i.test(String(s.providerId || ''))
                && !/^midi-input/i.test(String(s.label || '')));
            // No label de-dupe here. The audio-input capability already
            // collapses exact duplicates by logicalSourceKey
            // (_visibleInputSources), so nothing it returns shares a key. A
            // device that enumerates under several driver types (ASIO / Windows
            // Audio / DirectSound) has a DISTINCT key per type and is now
            // labelled with its driver type (e.g. "Focusrite (ASIO)") — each is
            // a real, separately-selectable input the user must be able to see.
            // The old bare-label collapse also kept whichever variant sorted
            // first, which could silently drop the one that was actually
            // `selected` below.
            const selected = sources.find((s) => s && s.selected) || null;
            return { sources, selected };
        } catch (_) { return { sources: [], selected: null }; }
    }

    // ── Wizard UI ────────────────────────────────────────────────────────────
    // Renders sequential per-instrument panels into `host`. Resolves the
    // returned promise to { completed:[...], skipped:[...] } when finished.
    function _runWizard(opts) {
        opts = opts || {};
        const instruments = (Array.isArray(opts.instruments) ? opts.instruments : [])
            .map((i) => String(i).toLowerCase()).filter((i) => INSTRUMENTS[i]);
        // De-dupe keys/piano (same MIDI flow under one label).
        const seen = new Set();
        const queue = instruments.filter((i) => { const k = INSTRUMENTS[i].label; if (seen.has(k)) return false; seen.add(k); return true; });

        const completed = [];
        const skipped = [];
        let idx = 0;

        return new Promise((resolve) => {
            const host = opts.host;
            if (!host) { resolve({ completed, skipped }); return; }

            function finish() {
                _emitOwner('calibration-done', { completed: completed.slice(), skipped: skipped.slice() });
                if (typeof opts.onComplete === 'function') { try { opts.onComplete({ completed, skipped }); } catch (_) {} }
                resolve({ completed, skipped });
            }
            // Per-panel teardown run on EVERY exit (Continue or the generic "Skip
            // for now"), so an opened MIDI session/listener never leaks past the
            // panel that opened it.
            let _activeCleanup = null;
            function next() {
                if (idx >= queue.length) { finish(); return; }
                renderPanel(queue[idx]);
            }
            function advance(inst, didComplete) {
                if (_activeCleanup) { try { _activeCleanup(); } catch (_) {} _activeCleanup = null; }
                if (didComplete) { _markDone(inst, true); if (!completed.includes(inst)) completed.push(inst); }
                else { if (!skipped.includes(inst)) skipped.push(inst); }
                idx += 1;
                next();
            }

            function shell(inst, bodyHtml, footHtml) {
                const meta = INSTRUMENTS[inst];
                host.innerHTML =
                    '<div class="space-y-4">' +
                    '<div><div class="text-xs uppercase tracking-wider text-fb-textDim">Input setup — step ' + (idx + 1) + ' of ' + queue.length + '</div>' +
                    '<h3 class="text-lg font-bold text-fb-text mt-0.5">Set up your ' + esc(meta.label) + '</h3></div>' +
                    '<div data-is-body>' + bodyHtml + '</div>' +
                    '<div class="flex justify-between items-center pt-1">' +
                    '<button type="button" data-is-skip class="text-sm text-fb-textDim hover:text-fb-text">Skip for now</button>' +
                    '<div data-is-foot>' + (footHtml || '') + '</div></div></div>';
                host.querySelector('[data-is-skip]').addEventListener('click', () => advance(inst, false));
            }

            // ── per-instrument panels ───────────────────────────────────────
            async function renderPanel(inst) {
                const meta = INSTRUMENTS[inst];
                if (meta.mode === 'audio') return renderAudioPanel(inst);
                return renderMidiPanel(inst);
            }

            // Guitar/bass: show the audio source (audio-input), a live "we can
            // hear you" meter, then launch the note_detect Calibration Wizard for
            // the deep work.
            async function renderAudioPanel(inst) {
                const { sources, selected } = await _audioSources();
                const opts2 = sources.map((s) =>
                    '<option value="' + esc(s.logicalSourceKey || s.sourceId || '') + '"' + (s.selected ? ' selected' : '') + '>' + esc(s.label || 'Input') + '</option>').join('');
                const hasDetector = !!(window.noteDetect && typeof window.noteDetect.launchCalibration === 'function');
                // The live-meter gate needs the detector to expose its input level
                // (getInputLevel) and the enable/disable capture lifecycle. When any
                // is missing (older detector / none) we degrade to the prior
                // calibrate-only flow rather than show a meter we can't feed.
                const nd = window.noteDetect;
                const canMeter = !!(hasDetector && nd
                    && typeof nd.getInputLevel === 'function'
                    && typeof nd.enable === 'function'
                    && typeof nd.disable === 'function'
                    && typeof nd.isEnabled === 'function'
                    && sources.length);
                const body =
                    '<p class="text-sm text-fb-textDim">Pick your audio input, then ' +
                    (canMeter ? 'play a note so we can confirm we hear it — then calibrate or continue.' : 'run the calibration to set levels, channel and latency.') + '</p>' +
                    (sources.length
                        ? '<label class="block text-xs uppercase tracking-wider text-fb-textDim mt-3 mb-1">Audio input</label>' +
                          '<select data-is-audio class="w-full bg-gray-800/50 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-fb-text outline-none">' + opts2 + '</select>'
                        : '<p class="text-sm text-fb-accent mt-2">No audio input detected yet — plug in your interface, or skip and set this up later.</p>') +
                    (canMeter
                        ? '<div class="mt-3"><button type="button" data-is-test class="text-sm text-fb-primary hover:text-fb-primaryHi">Test input</button>' +
                          '<div data-is-meter-wrap class="hidden mt-2">' +
                          '<div class="h-2 w-full bg-gray-800 rounded overflow-hidden"><div data-is-meter class="h-full w-0 bg-fb-primary" style="transition:width 80ms linear"></div></div>' +
                          '<p data-is-test-msg class="text-sm text-fb-textDim mt-1.5">Play your ' + esc(String(INSTRUMENTS[inst].label).toLowerCase()) + ' — waiting for signal…</p></div></div>'
                        : '') +
                    (hasDetector ? '' : '<p class="text-xs text-fb-textDim mt-3">The note detector isn’t loaded here — you can calibrate later from the player.</p>');
                // canMeter: a gated "Continue" (enabled once we hear you) PLUS an
                // always-enabled "Calibrate" — never gate Calibrate, since it's the
                // tool that fixes a too-low input that produces no signal.
                const foot = canMeter
                    ? '<button type="button" data-is-cal class="border border-gray-600 hover:border-gray-400 text-fb-text px-4 py-2 rounded-md font-medium mr-2">Calibrate</button>' +
                      '<button type="button" data-is-cont disabled class="bg-fb-primary hover:bg-fb-primaryHi disabled:opacity-40 text-white px-5 py-2 rounded-md font-medium">Continue</button>'
                    : '<button type="button" data-is-cal class="bg-fb-primary hover:bg-fb-primaryHi text-white px-5 py-2 rounded-md font-medium">' +
                      (hasDetector ? 'Calibrate' : 'Continue') + '</button>';
                shell(inst, body, foot);

                const sel = host.querySelector('[data-is-audio]');
                const commitAudio = (key) => {
                    if (!capabilities || !key) return Promise.resolve();
                    // Awaitable: the meter must reopen on the *committed* selection,
                    // so callers can sequence enable() after the choice persists.
                    return capabilities.command('audio-input', 'select-source', { requester: 'input_setup', payload: { logicalSourceKey: key } }).catch(() => {});
                };

                // ── live "we can hear you" meter ────────────────────────────────
                const meterWrap = host.querySelector('[data-is-meter-wrap]');
                const meterBar = host.querySelector('[data-is-meter]');
                const testMsg = host.querySelector('[data-is-test-msg]');
                const contBtn = host.querySelector('[data-is-cont]');
                // Idle hiss sits well under this; a plucked string clears it easily.
                const SIGNAL_THRESHOLD = 0.04;
                let pollTimer = null;
                let testing = false;
                // Detection on/off BEFORE we first opened the preview — captured once,
                // so we restore it on exit even after device-change reopens.
                let preTestEnabled = null;
                let handingOff = false; // Calibrate owns the capture from here on
                let testGen = 0; // invalidate in-flight startTest()s on change/exit

                function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
                function resetGate() {
                    if (contBtn) contBtn.disabled = true;
                    _markDone(inst, false);
                    if (meterBar) meterBar.style.width = '0%';
                    if (testMsg) testMsg.textContent = 'Play your ' + String(INSTRUMENTS[inst].label).toLowerCase() + ' — waiting for signal…';
                }
                function startPoll() {
                    stopPoll();
                    let heard = 0;
                    pollTimer = setInterval(() => {
                        let lvl = 0;
                        try { lvl = (nd.getInputLevel() || {}).level || 0; } catch (_) { lvl = 0; }
                        if (meterBar) meterBar.style.width = Math.min(100, Math.round(lvl * 140)) + '%';
                        if (lvl >= SIGNAL_THRESHOLD) {
                            // Require two consecutive ticks so a single click/pop
                            // doesn't false-pass the gate.
                            if (++heard >= 2 && contBtn && contBtn.disabled) {
                                if (testMsg) testMsg.innerHTML = '<span class="text-fb-primary font-semibold">✓ We can hear you</span> — your input is working.';
                                contBtn.disabled = false;
                                _markDone(inst, true);
                            }
                        } else { heard = 0; }
                    }, 100);
                }
                async function startTest() {
                    const myGen = ++testGen; // a newer change/exit supersedes us
                    stopPoll();
                    resetGate();
                    if (meterWrap) meterWrap.classList.remove('hidden');
                    // Persist the shown choice, THEN (re)open it: enable() is a no-op
                    // when detection is already on, so a device change while testing
                    // must cycle disable→enable or the meter would read the stale
                    // device — false confidence, the exact bug this gate prevents.
                    await commitAudio(sel.value);
                    if (myGen !== testGen) return;
                    try {
                        // Capture the pre-preview detection state ONCE so we restore it
                        // on exit (a later reopen must not lose that we own the enable).
                        if (preTestEnabled === null) preTestEnabled = !!nd.isEnabled();
                        if (nd.isEnabled()) { await nd.disable(); if (myGen !== testGen) return; }
                        await nd.enable();
                    } catch (_) { /* fail-soft: meter just won't move; Calibrate still works */ }
                    if (myGen !== testGen) return;
                    testing = true;
                    startPoll();
                }

                if (sel) {
                    sel.addEventListener('change', async () => {
                        if (testing) { await startTest(); }
                        else { await commitAudio(sel.value); resetGate(); }
                    });
                    // The <select> shows its first option by default, but no `change`
                    // fires for that implicit pick — so on a first run with nothing yet
                    // selected, audio-input would calibrate against the wrong/no source.
                    // Commit the shown option up-front so the displayed device is the
                    // one calibrated (idempotent if it was already selected).
                    if (!selected) commitAudio(sel.value);
                }
                const testBtn = host.querySelector('[data-is-test]');
                if (testBtn) testBtn.addEventListener('click', () => { startTest(); });
                if (contBtn) contBtn.addEventListener('click', () => advance(inst, true));
                // Restore detection state on ANY exit (Continue / Skip), unless we've
                // handed the capture off to the Calibration Wizard, which owns it.
                _activeCleanup = () => {
                    stopPoll();
                    testing = false;
                    testGen++; // cancel any in-flight startTest()
                    // Restore the pre-preview detection state unless the Calibration
                    // Wizard has taken ownership of the capture.
                    if (preTestEnabled === false && !handingOff) { try { nd.disable(); } catch (_) {} }
                };

                // Tell the tuner tables / note_detect which instrument this is.
                try { fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instrument: inst }) }); } catch (_) {}

                host.querySelector('[data-is-cal]').addEventListener('click', () => {
                    // Hand the (possibly already-open) capture to the Calibration
                    // Wizard — it calls enable() itself and manages teardown — so our
                    // cleanup must not disable detection out from under it.
                    handingOff = true;
                    stopPoll();
                    testGen++; // cancel any in-flight startTest() before handoff
                    if (hasDetector) {
                        // Hide our own full-screen overlay while note_detect's
                        // Calibration Wizard runs on top. That wizard goes
                        // transparent (pointer-events:none) when it minimizes to
                        // expose the Tuner; if our overlay stayed up it would show
                        // through — covering the tuner with the still-mounted
                        // "select your input" card and looking like a second
                        // wizard at the input step. Restore it on done/cancel
                        // (one of which always fires when that wizard closes).
                        const ov = document.getElementById('input-setup-overlay');
                        const prevDisplay = ov ? ov.style.display : '';
                        if (ov) ov.style.display = 'none';
                        const restore = () => {
                            const o = document.getElementById('input-setup-overlay');
                            if (o) o.style.display = prevDisplay;
                        };
                        window.noteDetect.launchCalibration({
                            instrument: inst,
                            onDone: () => { restore(); advance(inst, true); },
                            onCancel: () => {
                                restore();
                                // Back on this panel: reclaim cleanup ownership so a
                                // later Skip/Continue still restores the pre-preview
                                // detection state (preTestEnabled is unchanged).
                                handingOff = false;
                            },
                        });
                    } else {
                        advance(inst, true);
                    }
                });
            }

            // Keys/drums: pick a MIDI device via midi-input and confirm a live hit.
            async function renderMidiPanel(inst) {
                const mi = window.feedBack.midiInput;
                // Availability is the midi-input DOMAIN being present, not the
                // Web-MIDI browser API — the domain coordinates providers (the
                // built-in Web-MIDI one, plus any native/desktop adapter), so
                // gating on navigator.requestMIDIAccess would hide a usable
                // non-Web-MIDI provider before discover() is ever called.
                const midiAvailable = !!(mi && mi.version === 1);
                if (!midiAvailable) {
                    shell(inst,
                        '<p class="text-sm text-fb-accent">MIDI input isn’t available here. Connect a MIDI keyboard/e-kit in a supported environment, or skip for now.</p>',
                        '<button type="button" data-is-skip2 class="bg-fb-primary hover:bg-fb-primaryHi text-white px-5 py-2 rounded-md font-medium">Continue</button>');
                    host.querySelector('[data-is-skip2]').addEventListener('click', () => advance(inst, false));
                    return;
                }
                const verb = inst === 'drums' ? 'hit a pad' : 'play a note';
                shell(inst,
                    '<p class="text-sm text-fb-textDim">Connect your MIDI device, pick it below, then ' + verb + ' to confirm it’s working.</p>' +
                    '<div class="mt-3 flex items-center gap-2">' +
                    '<button type="button" data-is-scan class="text-sm text-fb-primary hover:text-fb-primaryHi">Scan for MIDI devices</button></div>' +
                    '<div data-is-midi-wrap class="hidden mt-2">' +
                    '<select data-is-midi class="w-full bg-gray-800/50 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-fb-text outline-none"></select>' +
                    '<p data-is-test class="text-sm text-fb-textDim mt-2">Waiting for input…</p></div>',
                    '<button type="button" data-is-next disabled class="bg-fb-primary disabled:opacity-40 text-white px-5 py-2 rounded-md font-medium">Continue</button>');

                const wrap = host.querySelector('[data-is-midi-wrap]');
                const select = host.querySelector('[data-is-midi]');
                const testEl = host.querySelector('[data-is-test]');
                const nextBtn = host.querySelector('[data-is-next]');
                let activeKey = null;
                let listener = null;
                let activeHandle = null;
                let openSeq = 0;

                async function openSelected() {
                    // Tear down the previous device + RESET the confirmation
                    // state, so a hit on a prior device can't leave Continue
                    // enabled for a newly-selected device that hasn't been heard.
                    const myGen = ++openSeq;
                    if (activeHandle && listener) { try { activeHandle.removeListener(listener); } catch (_) {} }
                    if (activeKey) { try { mi.close({ requester: 'input_setup', logicalSourceKey: activeKey }); } catch (_) {} }
                    activeHandle = null;
                    listener = null;
                    nextBtn.disabled = true;
                    _markDone(inst, false);
                    // Capture the requested key in a local: a newer openSelected()
                    // overwrites the shared `activeKey`, so comparing it after the
                    // awaits would let a stale open bind the wrong device.
                    const requestedKey = select.value;
                    activeKey = requestedKey;
                    if (!requestedKey) { testEl.textContent = ''; return; }
                    testEl.textContent = 'Waiting for input…';
                    await mi.select(requestedKey);
                    const res = await mi.open({ requester: 'input_setup', logicalSourceKey: requestedKey });
                    // Discard a stale open if a newer openSelected() superseded us.
                    if (myGen !== openSeq) { try { if (res) mi.close({ requester: 'input_setup', logicalSourceKey: requestedKey }); } catch (_) {} return; }
                    if (!res || !res.handle) { testEl.textContent = 'Could not open this device.'; activeKey = null; return; }
                    activeHandle = res.handle;
                    listener = (data) => {
                        // 0x90 = note-on (any channel); velocity > 0.
                        if (data && (data[0] & 0xf0) === 0x90 && data[2] > 0) {
                            testEl.innerHTML = '<span class="text-fb-primary font-semibold">✓ Got it</span> — device is working.';
                            nextBtn.disabled = false;
                            _markDone(inst, true);
                        }
                    };
                    activeHandle.addListener(listener);
                }

                host.querySelector('[data-is-scan]').addEventListener('click', async () => {
                    await mi.discover();
                    // Show every source the midi-input domain surfaces — not just
                    // the built-in Web-MIDI provider — so a native/desktop MIDI
                    // adapter registered with the domain is selectable too.
                    const sources = window.feedBack.midiInput.listSources() || [];
                    if (!sources.length) { testEl && (testEl.textContent = ''); wrap.classList.remove('hidden'); select.innerHTML = '<option>No MIDI devices found</option>'; select.disabled = true; return; }
                    wrap.classList.remove('hidden');
                    select.disabled = false;
                    select.innerHTML = sources.map((s) => '<option value="' + esc(s.logicalSourceKey) + '"' + (s.selected ? ' selected' : '') + '>' + esc(s.label) + '</option>').join('');
                    openSelected();
                });
                select.addEventListener('change', openSelected);
                // Close the open session/listener on ANY exit (Continue or the
                // generic Skip), so a scanned+selected device doesn't keep its
                // Web-MIDI input live after the panel advances.
                _activeCleanup = () => {
                    if (activeHandle && listener) { try { activeHandle.removeListener(listener); } catch (_) {} }
                    if (activeKey) { try { mi.close({ requester: 'input_setup', logicalSourceKey: activeKey }); } catch (_) {} }
                    activeHandle = null; listener = null; activeKey = null;
                };
                nextBtn.addEventListener('click', () => advance(inst, true));
            }

            _emitOwner('calibration-started', { instruments: queue.slice() });
            next();
        });
    }

    function _emitOwner(event, detail) {
        try { capabilities && capabilities.emitEvent && capabilities.emitEvent('input-calibration', event, detail || {}); } catch (_) {}
    }

    // ── input-calibration owner domain ───────────────────────────────────────
    function _statusPayload(instruments) {
        const list = (Array.isArray(instruments) && instruments.length ? instruments : Object.keys(INSTRUMENTS))
            .map((i) => String(i).toLowerCase());
        const status = {};
        list.forEach((i) => { if (INSTRUMENTS[i]) status[i] = _isDone(i) ? 'done' : 'needs-setup'; });
        return status;
    }

    if (capabilities && typeof capabilities.registerOwner === 'function') {
        capabilities.registerOwner('input-calibration', {
            pluginId: 'input_setup',
            kind: 'command',
            safety: 'safe',
            commands: ['run', 'status', 'inspect'],
            events: ['calibration-started', 'calibration-done', 'calibration-skipped'],
            description: 'Per-instrument input-setup wizard workflow (audio via audio-input + note_detect; MIDI via midi-input).',
            handlers: {
                inspect: () => ({ outcome: 'handled', payload: { available: true, status: _statusPayload() } }),
                status: (ctx) => ({ outcome: 'handled', payload: { status: _statusPayload((ctx.payload || {}).instruments) } }),
                // `run` is fire-and-launch: an interactive wizard far exceeds the
                // ~250ms handler timeout, so it starts the overlay and returns
                // immediately. Completion is signaled by the `calibration-done`
                // event (mirrors audio-monitoring `start`). A second `run` while
                // one is open is a no-op (single overlay).
                run: (ctx) => {
                    const instruments = ((ctx.payload || {}).instruments) || [];
                    if (!document.getElementById('input-setup-overlay')) launch(instruments);
                    return { outcome: 'handled', payload: { started: true, instruments } };
                },
            },
        });
    }

    // ── public surface (onboarding + Settings re-entry) ──────────────────────
    function mount(container, options) {
        options = options || {};
        return _runWizard({ host: container, instruments: options.instruments || [], onComplete: options.onComplete, onSkip: options.onSkip });
    }

    function launch(instruments) {
        const overlay = document.createElement('div');
        overlay.id = 'input-setup-overlay';
        overlay.className = 'fixed inset-0 z-[210] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4';
        overlay.innerHTML = '<div class="bg-fb-card rounded-xl border border-fb-border/50 w-full max-w-lg p-6" data-is-host></div>';
        document.body.appendChild(overlay);
        const host = overlay.querySelector('[data-is-host]');
        return _runWizard({ host, instruments: instruments || [] }).then((r) => { overlay.remove(); return r; });
    }

    window.feedBackInputSetup = {
        version: 1,
        mount,
        launch,
        status: (instruments) => _statusPayload(instruments),
    };

    // Settings-panel re-entry (settings.html "Set up input devices" button).
    // Re-runs the wizard for the player's selected instrument paths, falling
    // back to all instruments when progression isn't available.
    window._inputSetupRelaunch = async function () {
        let instruments = [];
        try {
            const r = await fetch('/api/progression');
            if (r.ok) {
                const d = await r.json();
                const paths = Array.isArray(d.paths) ? d.paths : [];
                instruments = paths.map((p) => (typeof p === 'string' ? p : (p && p.id))).filter(Boolean);
            }
        } catch (_) { /* offline — fall back below */ }
        if (!instruments.length) instruments = ['guitar', 'bass', 'keys', 'drums'];
        launch(instruments);
    };
})();
