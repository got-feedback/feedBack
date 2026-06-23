/*
 * fee[dB]ack v0.3.0 — topbar Tuner + Instrument Selector cards.
 *
 * Implements the Google Stitch "Tuner and Instrument Selector Components"
 * (project 2627687099825089475): charcoal rounded cards — a tuner display
 * (vertical heat-gradient meter + active-green segment + big italic note +
 * Hz) and an instrument selector (guitar icon + chevron dropdown), scaled to
 * the header row.
 *
 * Behaviour:
 *  - Clicking the tuner card opens the SAME tuner as the plugin's floating
 *    "Tuner" button (window.tuner.toggle() / #tuner-toggle-btn).
 *  - The instrument selector persists instrument/strings/tuning/reference in
 *    /api/settings, emits `instrument:changed`, AND pushes the selection into
 *    the tuner plugin (POST /api/plugins/tuner/config + window._tunerReloadConfig)
 *    so the tuner auto-switches its tuning.
 */
(function () {
    'use strict';
    const sm = window.feedBack;
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    const STRING_COUNTS = { guitar: [6, 7, 8], bass: [4, 5] };
    // Tuning names per instrument key (e.g. 'guitar-6', 'bass-4'), loaded from
    // GET /api/tunings. Falls back to empty arrays until the fetch resolves.
    let _tuningsByKey = {};
    function _tuningsForKey(key) { return Object.keys(_tuningsByKey[key] || {}); }
    function _tuningsForInstrument(instrument, string_count) {
        return _tuningsForKey(instrument + '-' + string_count);
    }

    // Lowest-string note per tuning name, for the tuner card's note readout.
    // Populated from /api/tunings frequencies: low string = index 0.
    let TUNING_NOTE = {};
    // Chromatic scale (C-based). Index 0 = lowest string relative to E2 (82.41 Hz).
    // The lowest open string of guitar-6 Standard is E2; offset 0 maps to 'E'.
    const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
    function _freqToNote(hz) {
        if (!hz || !Number.isFinite(hz) || hz <= 0) return 'E';
        const midi = Math.round(69 + 12 * Math.log2(hz / 440));
        return NOTE_NAMES[((midi % 12) + 12) % 12];
    }
    // Resolve a custom offset-array tuning to a readable low-string note name.
    // Offsets are semitones from E Standard (index 0 = lowest string).
    function lowStringNote(off) {
        const semis = Array.isArray(off) && Number.isFinite(off[0]) ? off[0] : 0;
        return NOTE_NAMES[(((4 + semis) % 12) + 12) % 12];
    }
    // Display label for the active tuning: a named tuning as-is, or 'Custom'
    // for an offset-array tuning (which has no canonical name).
    function tuningLabel() {
        return typeof settings.tuning === 'string' ? settings.tuning : 'Custom';
    }

    let settings = { instrument: 'guitar', string_count: 6, tuning: 'Standard', reference_pitch: 440 };

    async function loadTunings() {
        try {
            const r = await fetch('/api/tunings');
            if (!r.ok) return;
            const data = await r.json();
            _tuningsByKey = data.tunings || {};
            // Build TUNING_NOTE from the first (lowest) string frequency of each tuning.
            TUNING_NOTE = {};
            for (const key of Object.keys(_tuningsByKey)) {
                for (const [name, freqs] of Object.entries(_tuningsByKey[key])) {
                    if (!(name in TUNING_NOTE) && Array.isArray(freqs) && freqs.length > 0) {
                        TUNING_NOTE[name] = _freqToNote(freqs[0]);
                    }
                }
            }
        } catch (_) { /* non-fatal — TUNINGS falls back to empty, dropdown shows nothing */ }
    }

    async function loadSettings() {
        try {
            const r = await fetch('/api/settings');
            if (r.ok) {
                const s = await r.json();
                // Clamp persisted values to valid ranges — config.json could
                // hold out-of-range data (hand-edited or from an import), and the
                // badge/tuner must render consistent state, not a bad number.
                const instrument = s.instrument === 'bass' ? 'bass' : 'guitar';
                const counts = STRING_COUNTS[instrument];
                const sc = Number(s.string_count);
                const scValid = counts.includes(sc) ? sc : counts[0];
                const tunings = _tuningsForInstrument(instrument, scValid);
                let ref = Number(s.reference_pitch);
                if (!Number.isFinite(ref)) ref = 440;
                // tuning: a known named tuning is used as-is; a custom
                // offset-array tuning (see /api/settings) is PRESERVED rather
                // than discarded — the named-tuning badge can't label it yet
                // (tracked for P23), and pushToTuner()/renderTuner() guard the
                // non-string case — anything else falls back to the default.
                let tuning;
                if (typeof s.tuning === 'string') tuning = tunings.includes(s.tuning) ? s.tuning : (tunings[0] || 'Standard');
                else if (Array.isArray(s.tuning)) tuning = s.tuning;
                else tuning = tunings[0] || 'Standard';
                settings = {
                    instrument: instrument,
                    string_count: scValid,
                    tuning: tuning,
                    reference_pitch: Math.min(450, Math.max(430, ref)),
                };
            }
        } catch (e) { /* settings endpoint always present */ }
    }

    async function saveSettings(patch) {
        // Only adopt the patch once the server accepts it. /api/settings returns
        // {error: ...} with HTTP 200 on a validation failure, so a rejected
        // patch must NOT mutate local state, emit instrument:changed, or push to
        // the tuner — otherwise the UI/tuner desync from the persisted config.
        let accepted = false;
        try {
            const r = await fetch('/api/settings', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
            });
            if (r.ok) {
                const body = await r.json().catch(() => ({}));
                accepted = !(body && body.error);
            }
        } catch (e) { /* non-fatal — leave settings unchanged */ }
        if (!accepted) return;
        Object.assign(settings, patch);
        if (sm && sm.emit) sm.emit('instrument:changed', {
            instrument: settings.instrument, stringCount: settings.string_count, tuning: settings.tuning,
        });
        pushToTuner();
        renderTuner(); // reflect new tuning on the tuner card
    }

    // Drive the tuner plugin's instrument + tuning from the selection.
    async function pushToTuner() {
        try {
            const lastInstrument = settings.instrument + '-' + settings.string_count; // e.g. guitar-6, bass-4
            // The tuner plugin keys its config by tuning NAME. A custom
            // offset-array tuning has no name, so sync only the instrument and
            // skip lastTuning rather than POST an array the plugin can't parse.
            const body = { lastInstrument };
            if (typeof settings.tuning === 'string') {
                body.lastTuning = settings.tuning;
            }
            await fetch('/api/plugins/tuner/config', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (typeof window._tunerReloadConfig === 'function') await window._tunerReloadConfig();
        } catch (e) { /* tuner plugin may be absent */ }
    }

    function openTuner() {
        // Same action as the plugin's floating "Tuner" button.
        if (window.tuner && typeof window.tuner.toggle === 'function') { window.tuner.toggle(); return; }
        const btn = document.getElementById('tuner-toggle-btn');
        if (btn) btn.click();
        // else: tuner plugin not installed — no-op.
    }

    // ── Live tuner badge helpers ──────────────────────────────────────────--
    let _lastFrame = null;
    // 11-bar heat gradient: index 0 = very flat (dark red), 5 = center (green), 10 = very sharp (dark red).
    // Each step = 5 cents; range ±25 cents.
    const _SEG_BASE = [
        'bg-red-900',                                               // 0  –25 cents
        'bg-red-700',                                               // 1  –20 cents
        'bg-orange-600',                                            // 2  –15 cents
        'bg-yellow-600',                                            // 3  –10 cents
        'bg-emerald-700',                                           // 4   –5 cents
        'bg-emerald-700',                                           // 5    0 cents (center)
        'bg-emerald-700',                                           // 6   +5 cents
        'bg-yellow-600',                                            // 7  +10 cents
        'bg-orange-600',                                            // 8  +15 cents
        'bg-red-700',                                               // 9  +20 cents
        'bg-red-900',                                               // 10 +25 cents
    ];
    function _segActiveClass(i) {
        if (i === 5)             return 'bg-emerald-400 shadow-[0_0_10px_3px_rgba(52,211,153,0.95)]';
        if (i === 4 || i === 6) return 'bg-emerald-500 shadow-[0_0_8px_2px_rgba(52,211,153,0.85)]';
        if (i === 3 || i === 7) return 'bg-yellow-400 shadow-[0_0_8px_2px_rgba(234,179,8,0.9)]';
        if (i === 2 || i === 8) return 'bg-orange-500 shadow-[0_0_6px_2px_rgba(249,115,22,0.85)]';
        if (i === 1 || i === 9) return 'bg-red-500 shadow-[0_0_6px_2px_rgba(239,68,68,0.8)]';
        return                          'bg-red-700 shadow-[0_0_4px_1px_rgba(185,28,28,0.7)]'; // 0 or 10
    }
    // Returns true when the tuning name implies flat notation (mirrors tuning-utils.js).
    function _preferFlats(tuningName) {
        return typeof tuningName === 'string' && /\b[A-G]b\b/.test(tuningName);
    }
    // Compute nearest chromatic note + cents deviation from raw freq (always free-tune).
    function _freeTuneCents(freq, useFlats, referencePitch) {
        if (!freq || freq <= 0) return { note: '—', cents: 0 };
        const ref = (referencePitch > 0 && isFinite(referencePitch)) ? referencePitch : 440;
        const midi = 69 + 12 * Math.log2(freq / ref);
        const rounded = Math.round(midi);
        const cents = Math.round((midi - rounded) * 100);
        const sharps = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
        const flats  = ['C','Db','D','Eb', 'E','F','Gb','G','Ab','A','Bb', 'B'];
        return { note: (useFlats ? flats : sharps)[((rounded % 12) + 12) % 12], cents };
    }
    function _applyFrame(frame) {
        const host = document.getElementById('v3-badge-tuner');
        if (!host) return;
        const noteEl = host.querySelector('[data-tuner-note]');
        const hzEl = host.querySelector('[data-tuner-hz]');
        const segs = host.querySelectorAll('[data-tuner-seg]');
        if (!segs.length) return; // skeleton not yet rendered
        if (!frame || !frame.hasSignal) {
            const fallbackNote = typeof settings.tuning === 'string'
                ? (TUNING_NOTE[settings.tuning] || 'E')
                : lowStringNote(settings.tuning);
            if (noteEl) noteEl.textContent = fallbackNote;
            if (hzEl) hzEl.textContent = Math.round(settings.reference_pitch || 440) + 'hz';
            segs.forEach((s, i) => { s.className = 'w-5 h-[3px] rounded-full ' + _SEG_BASE[i]; });
            return;
        }
        // Always free-tune: derive note + cents from raw freq, ignoring tuning target.
        const { freq } = frame;
        const { note, cents } = _freeTuneCents(freq, _preferFlats(settings.tuning), settings.reference_pitch);
        if (noteEl) noteEl.textContent = note;
        if (hzEl) hzEl.textContent = Math.round(freq) + 'hz';
        // cents ±25 maps to indices 0–10; centre (0¢) = index 5, sharp (+) = top (0), flat (–) = bottom (10).
        const activeIdx = Math.max(0, Math.min(10, 5 - Math.round(cents / 5)));
        segs.forEach((s, i) => {
            s.className = 'w-5 h-[3px] rounded-full ' + (i === activeIdx ? _segActiveClass(i) : _SEG_BASE[i]);
        });
    }

    // ── Tuner card (Stitch LeftTunerComponent) ────────────────────────────--
    function renderTuner() {
        const host = document.getElementById('v3-badge-tuner');
        if (!host) return;
        const hz = Math.round(settings.reference_pitch || 440);
        const initNote = typeof settings.tuning === 'string'
            ? (TUNING_NOTE[settings.tuning] || 'E') : lowStringNote(settings.tuning);
        const seg = (i) => '<div data-tuner-seg="' + i + '" class="w-5 h-[3px] rounded-full ' + _SEG_BASE[i] + '"></div>';
        const meter = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(seg).join('');
        host.innerHTML =
            '<div id="v3-tuner-wrap" class="relative">' +
            '<button type="button" data-open-tuner title="Open tuner" ' +
            'class="bg-fb-card border border-fb-border/50 rounded-2xl h-[92px] w-[96px] shrink-0 px-3 flex items-center gap-3 overflow-hidden hover:ring-1 hover:ring-fb-primary/40 transition">' +
            '<div class="shrink-0 flex flex-col gap-[3px] items-center justify-center">' + meter + '</div>' +
            '<div class="min-w-0 text-white text-center leading-none">' +
            '<div data-tuner-note class="text-2xl font-black italic tracking-tighter leading-none">' + esc(initNote) + '</div>' +
            '<div data-tuner-hz class="text-[9px] text-gray-400 mt-0.5 tracking-wider truncate">' + hz + 'hz</div>' +
            '</div></button>' +
            '</div>';
        host.querySelector('[data-open-tuner]').addEventListener('click', (e) => {
            e.stopPropagation();
            const tunerPanel = document.getElementById('tuner-plugin-ui');
            const tunerIsOpen = tunerPanel && !tunerPanel.classList.contains('hidden');
            if (!tunerIsOpen) {
                // About to open — close the instruments panel first.
                closeInstMenu();
                document.removeEventListener('click', closeInstMenu);
            }
            openTuner();
        });
        _applyFrame(_lastFrame);
    }

    // ── Instrument selector card (Stitch RightInstrumentSelector) ──────────--
    const guitarIcon =
        '<svg class="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M21.66 3.34a1.2 1.2 0 0 0-1.7 0l-2.1 2.1-.7-.7a1 1 0 0 0-1.42 1.42l.3.3-6.06 6.05a4.5 4.5 0 1 0 1.42 1.42l6.05-6.06.3.3a1 1 0 0 0 1.42-1.42l-.7-.7 2.1-2.1a1.2 1.2 0 0 0 0-1.7zM7 19a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/></svg>';

    // Instrument-menu open/close helpers keyed by id (NOT a captured element),
    // so they survive renderInstrument() replacing the menu node. closeInstMenu
    // is a stable named handler so it can be registered/removed across opens.
    function liveInstMenu() {
        const host = document.getElementById('v3-badge-instrument');
        return host ? host.querySelector('[data-inst-menu]') : null;
    }
    function closeInstMenu() { const m = liveInstMenu(); if (m) m.classList.add('hidden'); }
    function openInstMenu() {
        const m = liveInstMenu();
        if (!m) return;
        // Close the tuner panel if it is open so the two panels are mutually exclusive.
        const tunerPanel = document.getElementById('tuner-plugin-ui');
        if (tunerPanel && !tunerPanel.classList.contains('hidden') && window.tuner) {
            window.tuner.disable();
        }
        m.classList.remove('hidden');
        // (Re)register the outside-click closer for whatever the CURRENT menu
        // node is — dedupe first so repeated opens don't stack listeners.
        document.removeEventListener('click', closeInstMenu);
        document.addEventListener('click', closeInstMenu, { once: true });
    }

    function renderInstrument() {
        const host = document.getElementById('v3-badge-instrument');
        if (!host) return;
        host.innerHTML =
            '<div id="v3-instrument-wrap" class="relative">' +
            '<button type="button" data-inst-toggle title="Instrument: ' + esc(settings.string_count + '-str ' + tuningLabel()) + '" ' +
            'class="bg-fb-card border border-fb-border/50 rounded-2xl h-[92px] w-16 flex flex-col items-center justify-center gap-2 hover:ring-1 hover:ring-fb-primary/40 transition">' +
            guitarIcon +
            '<svg class="w-4 h-4 text-white" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5"/></svg>' +
            '</button>' +
            '<div data-inst-menu class="hidden absolute right-0 mt-2 w-60 bg-fb-card border border-fb-border/50 rounded-xl shadow-xl p-3 z-50 space-y-3">' +
            instRow('Instrument', ['guitar', 'bass'].map((v) =>
                pill('inst', v, v[0].toUpperCase() + v.slice(1), settings.instrument === v)).join('')) +
            instRow('Strings', STRING_COUNTS[settings.instrument].map((v) =>
                pill('strings', v, v + '', settings.string_count === v)).join('')) +
            '<div><div class="text-[10px] uppercase tracking-wider text-fb-textDim mb-1">Tuning</div>' +
            '<select data-inst-tuning class="w-full bg-gray-800/50 border border-gray-700 rounded-md px-2 py-1.5 text-xs text-fb-text outline-none focus:border-fb-primary">' +
            // An offset-array tuning has no named option — surface it as a
            // disabled, selected 'Custom' entry so the dropdown reflects reality
            // (picking a named tuning still works and replaces the custom one).
            (typeof settings.tuning === 'string' ? '' : '<option selected disabled>Custom</option>') +
            _tuningsForInstrument(settings.instrument, settings.string_count).map((t) => '<option' + (t === settings.tuning ? ' selected' : '') + '>' + esc(t) + '</option>').join('') + '</select></div>' +
            '<div><div class="flex justify-between text-[10px] uppercase tracking-wider text-fb-textDim mb-1"><span>Reference pitch</span><span data-ref-val>' + settings.reference_pitch + ' Hz</span></div>' +
            '<input data-inst-ref type="range" min="430" max="450" step="1" value="' + settings.reference_pitch + '" class="w-full slider-input"></div>' +
            '</div></div>';

        const toggle = host.querySelector('[data-inst-toggle]');
        const menu = host.querySelector('[data-inst-menu]');
        // Open/close via the id-based helpers so the outside-click closer always
        // targets the live menu (renderInstrument may replace this node) and is
        // only armed while the menu is actually open.
        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            if (menu.classList.contains('hidden')) openInstMenu();
            else { closeInstMenu(); document.removeEventListener('click', closeInstMenu); }
        });
        menu.addEventListener('click', (e) => e.stopPropagation());
        // After a settings change re-renders the menu, re-open the NEW node and
        // re-arm its outside-click closer (openInstMenu re-queries by id).
        const keepOpen = openInstMenu;
        menu.querySelectorAll('[data-pill="inst"]').forEach((b) => b.addEventListener('click', async () => {
            const v = b.getAttribute('data-val');
            const counts = STRING_COUNTS[v];
            // Clamp string_count AND tuning to ones valid for the new
            // instrument, so switching can't persist (and push to the tuner) an
            // unsupported instrument+tuning combo.
            const newSc = counts.includes(settings.string_count) ? settings.string_count : counts[0];
            const tunings = _tuningsForInstrument(v, newSc);
            await saveSettings({
                instrument: v,
                string_count: newSc,
                tuning: tunings.includes(settings.tuning) ? settings.tuning : (tunings[0] || settings.tuning),
            });
            renderInstrument(); keepOpen();
        }));
        menu.querySelectorAll('[data-pill="strings"]').forEach((b) => b.addEventListener('click', async () => {
            await saveSettings({ string_count: Number(b.getAttribute('data-val')) }); renderInstrument(); keepOpen();
        }));
        menu.querySelector('[data-inst-tuning]').addEventListener('change', (e) => saveSettings({ tuning: e.target.value }));
        const ref = menu.querySelector('[data-inst-ref]');
        ref.addEventListener('input', (e) => { menu.querySelector('[data-ref-val]').textContent = e.target.value + ' Hz'; });
        ref.addEventListener('change', (e) => saveSettings({ reference_pitch: Number(e.target.value) }));
    }
    function instRow(label, inner) {
        return '<div><div class="text-[10px] uppercase tracking-wider text-fb-textDim mb-1">' + label + '</div><div class="flex flex-wrap gap-1">' + inner + '</div></div>';
    }
    function pill(group, val, label, active) {
        return '<button type="button" data-pill="' + group + '" data-val="' + val + '" class="px-2 py-1 rounded-md text-xs ' +
            (active ? 'bg-fb-primary text-white' : 'bg-gray-800/50 text-fb-textDim hover:text-fb-text') + '">' + esc(label) + '</button>';
    }

    window.v3Badges = { reload: async () => { await Promise.all([loadTunings(), loadSettings()]); renderInstrument(); renderTuner(); } };

    async function boot() {
        await Promise.all([loadTunings(), loadSettings()]);
        renderInstrument();
        renderTuner();
        pushToTuner(); // sync the tuner to the persisted selection on load
        if (sm && sm.on) {
            sm.on('tuner:frame', (e) => {
                _lastFrame = e.detail;
                _applyFrame(e.detail);
            });
            sm.on('tunings:updated', async () => {
                await loadTunings();
                renderInstrument();
            });
        }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();
