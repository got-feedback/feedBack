// Guitar/Bass Tuner Plugin for FeedBack
(function() {
    'use strict';
    const _TUNER_STORAGE_KEY = 'feedBack_tuner_settings';

    // ── Player sync state ─────────────────────────────────────────────
    let _onScreenChanged = null;
    let _onSongReady = null;
    let _outsideClickClose = null;

    // ── Auto-open on tuning change (in-memory only) ───────────────────
    let _lastTuningKey = null;
    let _lastAutoOpenSessionKey = null;
    let _autoOpenDismissedSessionKey = null;
    let _autoOpenGeneration = 0;
    let _onAutoOpenSongLoading = null;
    let _onAutoOpenSongReady = null;

    // ── Shared mutable state (read/written by screen.js; UI reads via closure) ──
    const _state = {
        uiContainer: null,
        vizContainer: null,
        instrumentSelect: null,
        tuningSelect: null,
        stringNoteContainer: null,
        saveAsCustomContainer: null,
        activeViz: null,
        selectedInstrument: 'guitar-6',
        selectedTuning: null,
        selectedTuningName: 'Standard',
        manualTargetFreq: null,
        tunings: {},
        _allTunings: {},
        referencePitch: 440,
        visualizationMode: 'default',
        showFloatingButton: true,
        currentSongOffsets: null,
        currentSongIsBass: false,
        currentSongStringCount: 0,
        _serverConfig: null,
        useFlats: false,
        enabled: false,
        _instrumentSentinel: null,
        selectedDeviceId: '',
        selectedChannel: 'mono',
        audioInputMode: 'auto',
        freeTune: false,
        freeTuneToggle: null,
    };
    let _tunerUIApi = null;

    // ── Script loader ─────────────────────────────────────────────────
    const _loadedScripts = new Set();
    function _loadScript(url) {
        if (_loadedScripts.has(url)) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = url;
            s.onload = () => { _loadedScripts.add(url); resolve(); };
            s.onerror = () => reject(new Error(`Tuner: failed to load "${url}"`));
            document.head.appendChild(s);
        });
    }

    function _loadVizScript(name) {
        return _loadScript(`/api/plugins/tuner/visualization/${name}.js`);
    }

    async function _setVisualization(name) {
        if (_state.activeViz) { _state.activeViz.destroy(); _state.activeViz = null; }
        try {
            await _loadVizScript(name);
            const factory = window[`_tunerViz_${name}`];
            if (typeof factory !== 'function') throw new Error(`Tuner: _tunerViz_${name} not defined`);
            _state.activeViz = factory(_state.vizContainer);
        } catch (e) {
            console.error(e);
            if (name !== 'default') {
                _state.visualizationMode = 'default';
                await _setVisualization('default');
            }
        }
    }

    // ── Tuning helpers ────────────────────────────────────────────────
    function _isTuningEnabled(instrument, name) {
        return !((_state._serverConfig ? _state._serverConfig.disabledTunings : null) || []).includes(instrument + ':' + name);
    }

    function _instrumentForTuning(name) {
        for (var key in _state._allTunings) {
            if (_state._allTunings[key] && _state._allTunings[key][name]) return key;
        }
        return 'guitar-6';
    }

    function _buildTuningsForInstrument(instrument) {
        const all = _state._allTunings[instrument] || {};
        const disabled = (_state._serverConfig ? _state._serverConfig.disabledTunings : null) || [];
        return Object.fromEntries(
            Object.entries(all).filter(([name]) => !disabled.includes(instrument + ':' + name))
        );
    }

    function _tuningIdentityKey(songInfo) {
        if (!songInfo || !Array.isArray(songInfo.tuning) || !songInfo.tuning.length) return null;
        const ctx = (typeof window.feedBack?.songTuningContext === 'function')
            ? window.feedBack.songTuningContext(songInfo)
            : {
                stringCount: songInfo.stringCount,
                arrangement: songInfo.arrangement,
                arrangement_smart_name: songInfo.arrangement_smart_name,
            };
        const isBass = (typeof window.feedBack?.isBassArrangement === 'function')
            ? window.feedBack.isBassArrangement(ctx)
            : (songInfo.arrangement || '').toLowerCase().includes('bass');
        const sc = (typeof window.feedBack?.effectiveStringCount === 'function')
            ? window.feedBack.effectiveStringCount(songInfo.tuning, ctx)
            : (songInfo.stringCount || songInfo.tuning.length);
        if (!sc || sc <= 0) return null;
        const offsets = songInfo.tuning.slice(0, sc);
        if (!offsets.length) return null;
        return (isBass ? 'b' : 'g') + ':' + sc + ':' + offsets.join(',');
    }

    function _autoOpenSessionKey(songInfo) {
        if (!songInfo) return '';
        const cur = window.feedBack?.currentSong;
        const filename = (cur && cur.filename) || songInfo.filename || songInfo.title || 'unknown';
        const arr = (cur && cur.arrangementIndex != null)
            ? cur.arrangementIndex
            : (songInfo.arrangement_index != null ? songInfo.arrangement_index : (songInfo.arrangement || ''));
        return filename + '::' + arr;
    }

    // ── §4 instrument-coverage ────────────────────────────────────────────────
    // FeedBack is tune-to-song: the highway draws tab in the SONG's tuning, so the
    // player tunes their instrument to match. We therefore only auto-open when the
    // player's CURRENT physical tuning doesn't already cover the song — i.e. the
    // song's open-string tuning isn't an exact contiguous run inside the player's
    // strings, OR the global reference differs. So an 8-string F# player isn't
    // nagged for a 6-/7-string standard song (its top strings already match), but a
    // Drop-A song whose dropped open string the player lacks still prompts.
    function _openMidisFromFreqs(freqs) {
        const u = window._tunerUtils;
        if (!u || !Array.isArray(freqs)) return null;
        return freqs.map((f) => Math.round(u.freqToMidi(f)));
    }

    // The song's open-string MIDI (at A440; centOffset handled separately as a
    // global). Mirrors _tuningIdentityKey's isBass / string-count derivation.
    function _songOpenMidis(songInfo) {
        const u = window._tunerUtils;
        if (!u || !songInfo || !Array.isArray(songInfo.tuning) || !songInfo.tuning.length) return null;
        const ctx = (typeof window.feedBack?.songTuningContext === 'function')
            ? window.feedBack.songTuningContext(songInfo)
            : { stringCount: songInfo.stringCount, arrangement: songInfo.arrangement, arrangement_smart_name: songInfo.arrangement_smart_name };
        const isBass = (typeof window.feedBack?.isBassArrangement === 'function')
            ? window.feedBack.isBassArrangement(ctx)
            : (songInfo.arrangement || '').toLowerCase().includes('bass');
        const sc = (typeof window.feedBack?.effectiveStringCount === 'function')
            ? window.feedBack.effectiveStringCount(songInfo.tuning, ctx)
            : (songInfo.stringCount || songInfo.tuning.length);
        if (!sc || sc <= 0) return null;
        const offsets = songInfo.tuning.slice(0, sc);
        if (!offsets.length) return null;
        return _openMidisFromFreqs(u.offsetsToFreqs(offsets, isBass));
    }

    // The player's PHYSICAL instrument from core /api/settings (the v3 instrument
    // badge's selection — a STABLE reference, NOT the tuner's song-tracking
    // _syncCurrentTuning). Returns { midis, refCents } or null.
    async function _playerTuning() {
        const u = window._tunerUtils;
        if (!u) return null;
        let s;
        try { s = await fetch('/api/settings').then((r) => (r && r.ok ? r.json() : null)); }
        catch (_) { return null; }
        if (!s) return null;
        const isBass = s.instrument === 'bass';
        const sc = Number(s.string_count) || (isBass ? 4 : 6);
        const refPitch = Number(s.reference_pitch) || 440;
        let freqs = null;
        if (Array.isArray(s.tuning)) {
            freqs = u.offsetsToFreqs(s.tuning.slice(0, sc), isBass);
        } else if (typeof s.tuning === 'string') {
            const named = _state._allTunings && _state._allTunings[(isBass ? 'bass' : 'guitar') + '-' + sc];
            if (named && Array.isArray(named[s.tuning])) freqs = named[s.tuning];
        }
        if (!freqs) freqs = u.offsetsToFreqs(new Array(sc).fill(0), isBass);   // standard fallback
        const midis = _openMidisFromFreqs(freqs);
        if (!midis) return null;
        return { midis, refCents: 1200 * Math.log2(refPitch / 440) };
    }

    // The retune the player would need to match this song, as a structured report:
    //   { covered, retune: [{ from, to }], reference, cantCover }
    // — covered: the physical tuning already matches (the song's open strings are an
    //   exact contiguous run inside the player's strings) → no retune;
    // — retune: the per-string note changes (e.g. { from:'B', to:'A' }) of the best
    //   contiguous alignment — what the badge cue names;
    // — reference: a whole-instrument A4/centOffset mismatch (A440 vs A432, octave);
    // — cantCover: the song needs more strings than the instrument has.
    // Conservative: any missing data → { covered:false } so a needed prompt/cue is
    // never silently dropped on a fetch hiccup.
    async function _coverageReport(songInfo) {
        const u = window._tunerUtils;
        const none = { covered: false, retune: [], reference: false, cantCover: false };
        if (!u) return none;
        const song = _songOpenMidis(songInfo);
        if (!song || !song.length) return none;
        const player = await _playerTuning();
        if (!player || !player.midis.length) return none;
        const reference = Math.abs((Number(songInfo?.centOffset) || 0) - player.refCents) > 25;
        if (player.midis.length < song.length) return { covered: false, retune: [], reference, cantCover: true };
        // Best contiguous alignment = the run with the fewest per-string mismatches
        // (extended-range adds strings at the ends — match by pitch, not index).
        let best = null;
        for (let start = 0; start + song.length <= player.midis.length; start++) {
            const diffs = [];
            for (let i = 0; i < song.length; i++) {
                const pm = player.midis[start + i];
                if (pm !== song[i]) diffs.push({ from: u.midiToNote(pm, false), to: u.midiToNote(song[i], false) });
            }
            if (!best || diffs.length < best.length) best = diffs;
            if (!diffs.length) break;
        }
        const covered = !reference && best.length === 0;
        return { covered, retune: covered ? [] : best, reference, cantCover: false };
    }

    // Boolean form used to gate the auto-open prompt.
    async function _coveredByPlayerInstrument(songInfo) {
        return (await _coverageReport(songInfo)).covered;
    }

    function _onAutoOpenSongLoadingHandler() {
        _autoOpenGeneration++;
        _autoOpenDismissedSessionKey = null;
        _lastAutoOpenSessionKey = null;
    }

    async function _maybeAutoOpenOnTuningChange() {
        if (!document.getElementById('player')?.classList.contains('active')) return;

        // Opt-in (default off): only auto-open when the user enabled it in the
        // tuner settings. Ensure config is loaded so the first song:ready after
        // boot still reads the real flag; fail closed if it can't load.
        if (!_state._serverConfig) { try { await loadConfig(); } catch (_) { /* */ } }
        if (!_state._serverConfig || !_state._serverConfig.autoOpenOnTuningChange) return;

        const songInfo = window.highway?.getSongInfo?.() || window.feedBack?.currentSong;
        if (!songInfo) return;

        const tuningKey = _tuningIdentityKey(songInfo);
        if (!tuningKey) return;

        const sessionKey = _autoOpenSessionKey(songInfo);
        const myGen = _autoOpenGeneration;

        if (_lastTuningKey === null) {
            _lastTuningKey = tuningKey;
            return;
        }

        if (tuningKey === _lastTuningKey) return;

        _lastTuningKey = tuningKey;

        if (_autoOpenDismissedSessionKey === sessionKey) return;
        if (_state.enabled) return;
        if (_lastAutoOpenSessionKey === sessionKey) return;
        if (!window.tuner || typeof window.tuner.enable !== 'function') return;

        // §4: skip the prompt when the player's physical instrument already covers
        // this song's tuning (e.g. an 8-string F# playing a 6-/7-string standard
        // song). Async (fetches /api/settings) — re-check the generation after.
        const covered = await _coveredByPlayerInstrument(songInfo);
        if (myGen !== _autoOpenGeneration) return;
        if (covered) return;

        _lastAutoOpenSessionKey = sessionKey;
        try {
            await window.tuner.enable({ auto: true });
            if (myGen !== _autoOpenGeneration) return;
        } catch (e) {
            console.warn('Tuner: auto-open failed:', e && e.message ? e.message : e);
            if (_lastAutoOpenSessionKey === sessionKey) _lastAutoOpenSessionKey = null;
            // NOTE: _lastTuningKey stays committed here. Rolling it back to retry
            // a failed enable on the same tuning would defeat the duplicate-
            // song:ready dedup this gate also enforces; a transient enable failure
            // (e.g. mic denied) is therefore not auto-retried until the tuning
            // changes. A proper retry needs a separate flag, deferred.
        }
    }

    function _installAutoOpenListeners() {
        if (_onAutoOpenSongLoading || !window.feedBack?.on) return;
        _onAutoOpenSongLoading = _onAutoOpenSongLoadingHandler;
        _onAutoOpenSongReady = () => { _maybeAutoOpenOnTuningChange(); };
        window.feedBack.on('song:loading', _onAutoOpenSongLoading);
        window.feedBack.on('song:ready', _onAutoOpenSongReady);
    }

    // ── Player sync helpers ───────────────────────────────────────────
    function _syncCurrentTuning() {
        const songInfo = window.highway?.getSongInfo();
        const onPlayer = document.getElementById('player')?.classList.contains('active');
        const wantCurrent = _state.selectedTuningName === '_current'
            || (onPlayer && songInfo?.tuning?.length);
        if (songInfo?.tuning?.length && wantCurrent) {
            _state.selectedTuningName = '_current';
            const ctx = (typeof window.feedBack?.songTuningContext === 'function')
                ? window.feedBack.songTuningContext(songInfo)
                : {
                    stringCount: songInfo.stringCount,
                    arrangement: songInfo.arrangement,
                    arrangement_smart_name: songInfo.arrangement_smart_name,
                };
            const isBass = (typeof window.feedBack?.isBassArrangement === 'function')
                ? window.feedBack.isBassArrangement(ctx)
                : (songInfo.arrangement || '').toLowerCase().includes('bass');
            const sc = (typeof window.feedBack?.effectiveStringCount === 'function')
                ? window.feedBack.effectiveStringCount(songInfo.tuning, ctx)
                : (songInfo.stringCount || songInfo.tuning.length);
            _state.currentSongOffsets = songInfo.tuning.slice(0, sc);
            _state.currentSongIsBass = isBass;
            _state.currentSongStringCount = sc;
            const _refScale = _state.referencePitch / 440;
            _state.selectedTuning = window._tunerUtils.offsetsToFreqs(_state.currentSongOffsets, isBass).map(f => f * _refScale);
            const songInstrument = isBass
                ? ('bass-' + (sc === 5 ? 5 : 4))
                : (sc === 8 ? 'guitar-8' : sc === 7 ? 'guitar-7' : 'guitar-6');
            if (songInstrument !== _state.selectedInstrument) {
                _state.selectedInstrument = songInstrument;
                _state.tunings = _buildTuningsForInstrument(_state.selectedInstrument);
                _tunerUIApi?.updateInstrumentDisplay();
            }
            if (_state.tuningSelect) _state.tuningSelect.value = '_current';
        } else {
            const first = Object.keys(_state.tunings)[0];
            if (first) {
                _state.selectedTuningName = first;
                _state.selectedTuning = _state.tunings[first];
                if (_state.tuningSelect) _state.tuningSelect.value = first;
                const derivedInstrument = _instrumentForTuning(first);
                if (derivedInstrument && derivedInstrument !== _state.selectedInstrument) {
                    _state.selectedInstrument = derivedInstrument;
                    if (_state.instrumentSelect) { _state.instrumentSelect.value = derivedInstrument; _tunerUIApi?.updateInstrumentDisplay(); }
                }
            }
        }
        _tunerUIApi?.renderStringNotes();
        _tunerUIApi?.updateSaveAsCustomVisibility();
    }

    // ── Persistence ───────────────────────────────────────────────────
    function loadSettings() {
        try {
            const s = JSON.parse(localStorage.getItem(_TUNER_STORAGE_KEY) || '{}');
            if (s.deviceId !== undefined) _state.selectedDeviceId = s.deviceId;
            if (['mono', 'left', 'right'].includes(s.channel)) _state.selectedChannel = s.channel;
        } catch (e) { /* unavailable */ }
    }

    function saveSettings() {
        try {
            localStorage.setItem(_TUNER_STORAGE_KEY, JSON.stringify({
                deviceId: _state.selectedDeviceId,
                channel: _state.selectedChannel,
            }));
        } catch (e) { /* unavailable */ }
    }

    async function loadConfig() {
        try {
            const [config, tuningsData] = await Promise.all([
                fetch('/api/plugins/tuner/config').then(r => r.json()),
                fetch('/api/tunings').then(r => r.json()),
            ]);
            _state._serverConfig = config;
            _state._allTunings = tuningsData.tunings || {};
            _state.referencePitch = tuningsData.referencePitch || 440;
            _state.showFloatingButton = config.showFloatingButton !== false;
            _state.visualizationMode = config.visualizationMode || 'default';
            _state.audioInputMode = config.audioInputMode || 'auto';

            if (config.lastInstrument && _state._allTunings[config.lastInstrument]) {
                _state.selectedInstrument = config.lastInstrument;
            }
            if (_state.instrumentSelect) { _state.instrumentSelect.value = _state.selectedInstrument; _tunerUIApi?.updateInstrumentDisplay(); }

            _state.tunings = _buildTuningsForInstrument(_state.selectedInstrument);

            const lastName = config.lastTuning;
            // Legacy saves stored 'free-tune' as lastTuning; treat that as
            // freeTune=true with no specific named tuning.
            const legacyFreeTune = lastName === 'free-tune';
            if (!legacyFreeTune && lastName && _state.tunings[lastName]) {
                _state.selectedTuningName = lastName;
                _state.selectedTuning = _state.tunings[lastName];
            } else {
                const first = Object.keys(_state.tunings)[0];
                if (first) { _state.selectedTuningName = first; _state.selectedTuning = _state.tunings[first]; }
            }

            _state.freeTune = legacyFreeTune || !!config.freeTune;

            _state.useFlats = window._tunerUtils
                ? window._tunerUtils.preferFlats(_state.selectedTuningName)
                : /\b[A-G]b\b/.test(_state.selectedTuningName || '');

            if (_state.tuningSelect) _tunerUIApi?.renderTuningOptions();
            if (_state.uiContainer && !_state.uiContainer.classList.contains('hidden')) _tunerUIApi?.renderStringNotes();
            _tunerUIApi?.updateSaveAsCustomVisibility();
            _tunerUIApi?.updateFreeTuneUI();
            _tunerUIApi?.updateFloatingButtonVisibility();
        } catch (e) {
            console.error('Tuner: Failed to load config', e);
        }
    }

    window._tunerReloadConfig = loadConfig;

    async function saveConfig() {
        // '_current' is the live song tuning; 'free-tune' is now tracked via the
        // freeTune boolean — neither should land in lastTuning.
        const tuningToSave = (_state.selectedTuningName === '_current' || _state.selectedTuningName === 'free-tune')
            ? null : _state.selectedTuningName;
        try {
            await fetch('/api/plugins/tuner/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    lastTuning: tuningToSave,
                    lastInstrument: _state.selectedInstrument,
                    visualizationMode: _state.visualizationMode,
                    freeTune: _state.freeTune,
                }),
            });
        } catch (e) {
            console.error('Tuner: Failed to save config', e);
        }
    }

    // ── Audio lifecycle ───────────────────────────────────────────────
    async function restartAudio() {
        _state.uiContainer?.querySelector('.tuner-mic-error')?.remove();
        try {
            await window._tunerAudio.restart({ deviceId: _state.selectedDeviceId, channel: _state.selectedChannel, audioInputMode: _state.audioInputMode });
        } catch (e) {
            console.error('Tuner: Failed to restart audio', e);
            disable();
            _tunerUIApi?.showMicError(e);
        }
    }

    async function enable(opts) {
        if (_state.enabled) return;
        // An AUTO-open (the "this song needs a different tuning" nudge) must
        // PERSIST: it is NOT dismissed by the autoplay song:play that follows
        // song entry, a stray click, or a same-screen re-emit — only by the
        // Skip/× buttons or leaving the song. A manual open keeps the classic
        // click-away / play-to-close behaviour.
        const auto = !!(opts && opts.auto);
        _state.autoOpened = auto;
        await _loadScript('/api/plugins/tuner/utils/tuning-utils.js');
        await _loadScript('/api/plugins/tuner/utils/audio.js');
        await _loadScript('/api/plugins/tuner/utils/ui.js');
        loadSettings();
        await loadConfig();

        if (document.querySelector('.screen.active')?.id === 'player') _state.selectedTuningName = '_current';

        if (!_tunerUIApi) {
            _tunerUIApi = window._tunerUI(_state, {
                saveConfig, loadConfig, saveSettings, disable, restartAudio,
                setVisualization: _setVisualization,
                buildTuningsForInstrument: _buildTuningsForInstrument,
            });
        }
        _tunerUIApi.initUI();
        _tunerUIApi.renderInstrumentOptions();
        _tunerUIApi.renderTuningOptions();
        if (_state.selectedTuningName === '_current') _syncCurrentTuning();
        else if (_state.selectedTuning) _tunerUIApi.renderStringNotes();
        _tunerUIApi.updateSaveAsCustomVisibility();

        await _setVisualization(_state.visualizationMode);

        _state.uiContainer.classList.remove('hidden');
        _state.uiContainer.classList.add('flex');
        _tunerUIApi.positionPanel();
        _tunerUIApi.updateFreeTuneUI();
        // "Skip" is the auto-open nudge's explicit dismiss; hidden for a manual
        // open (the × / click-away already close those).
        if (_state.skipBtn) _state.skipBtn.classList.toggle('hidden', !auto);

        // Close when clicking outside the panel. Deferred so the badge's opening
        // click doesn't bubble up to the document and fire immediately. Skipped
        // for an auto-open: the user never clicked to open it, so their first
        // unrelated click must not dismiss it (it persists until Skip/×/leave).
        if (!auto) {
            if (_outsideClickClose) document.removeEventListener('click', _outsideClickClose);
            _outsideClickClose = () => { if (_state.enabled) disable(); };
            setTimeout(() => { if (_outsideClickClose) document.addEventListener('click', _outsideClickClose, { once: true }); }, 0);
        }

        if (window.feedBack && !_onScreenChanged) {
            // Auto-opened: close only when we actually LEAVE the song — a player
            // re-emit while staying put must not tear down the nudge. Manual:
            // unchanged (any screen change closes it).
            _onScreenChanged = () => {
                if (!_state.autoOpened || !document.getElementById('player')?.classList.contains('active')) disable();
            };
            _onSongReady = () => {
                _tunerUIApi.renderTuningOptions();
                if (_state.selectedTuningName === '_current') _syncCurrentTuning();
            };
            window.feedBack.on('screen:changed', _onScreenChanged);
            window.feedBack.on('song:ready', _onSongReady);
        }

        _state.uiContainer?.querySelector('.tuner-mic-error')?.remove();
        try {
            // start() calls _doStop() internally, so this cleanly replaces any
            // existing auto-start session and registers the full UI callback.
            await window._tunerAudio.start(
                { deviceId: _state.selectedDeviceId, channel: _state.selectedChannel, audioInputMode: _state.audioInputMode },
                _tunerUIApi.updateUI
            );
            _state.enabled = true;
            if (window.tuner?.updateButtons) window.tuner.updateButtons();
        } catch (e) {
            console.error('Tuner: Failed to start audio', e);
            disable();
            _tunerUIApi?.showMicError(e);
        }
    }

    function disable() {
        const wasEnabled = _state.enabled;
        const onPlayer = document.getElementById('player')?.classList.contains('active');
        _state.enabled = false;
        _state.autoOpened = false;
        _state.manualTargetFreq = null;
        if (_outsideClickClose) { document.removeEventListener('click', _outsideClickClose); _outsideClickClose = null; }
        if (_state.activeViz) { _state.activeViz.destroy(); _state.activeViz = null; }
        if (_state.uiContainer) { _state.uiContainer.classList.add('hidden'); _state.uiContainer.classList.remove('flex'); }
        if (_onScreenChanged) { window.feedBack?.off('screen:changed', _onScreenChanged); _onScreenChanged = null; }
        if (_onSongReady) { window.feedBack?.off('song:ready', _onSongReady); _onSongReady = null; }
        if (window._tunerAudio) window._tunerAudio.stop();
        if (_state.vizContainer) _state.vizContainer.innerHTML = '';
        if (window.tuner?.updateButtons) window.tuner.updateButtons();
        // Resume background audio so the live badge keeps updating after the panel closes.
        if (window._tunerAudio && _tunerUIApi) {
            window._tunerAudio.start(
                { deviceId: _state.selectedDeviceId, channel: _state.selectedChannel, audioInputMode: _state.audioInputMode },
                _tunerUIApi.updateUI
            ).catch(e => console.warn('Tuner: badge audio resume failed:', e && e.message ? e.message : e));
        }
        if (wasEnabled && onPlayer) {
            const songInfo = window.highway?.getSongInfo?.() || window.feedBack?.currentSong;
            if (songInfo) _autoOpenDismissedSessionKey = _autoOpenSessionKey(songInfo);
        }
    }

    window.tuner = {
        enable,
        disable,
        toggle: () => _state.enabled ? disable() : enable(),
        updateButtons: () => {
            _tunerUIApi?.updateFloatingButton();
            _tunerUIApi?.updatePlayerButton();
            _tunerUIApi?.updateFloatingButtonVisibility();
        },
    };

    // Boot: load scripts, add toggle button, then auto-start audio for the live badge
    Promise.all([
        _loadScript('/api/plugins/tuner/utils/tuning-utils.js'),
        _loadScript('/api/plugins/tuner/utils/audio.js'),
        _loadScript('/api/plugins/tuner/utils/ui.js'),
    ]).then(async () => {
        _tunerUIApi = window._tunerUI(_state, {
            saveConfig, loadConfig, saveSettings, disable, restartAudio,
            setVisualization: _setVisualization,
            buildTuningsForInstrument: _buildTuningsForInstrument,
        });
        _tunerUIApi.addButton();
        loadSettings();
        await loadConfig();
        // Auto-start audio so the v3 badge receives live tuner:frame events from
        // page load, without requiring the user to open the tuner panel first.
        // Errors are silent — a permission prompt or missing device is non-fatal
        // here; the user will see the mic error modal if they explicitly open the
        // tuner via enable().
        try {
            await window._tunerAudio.start(
                { deviceId: _state.selectedDeviceId, channel: _state.selectedChannel, audioInputMode: _state.audioInputMode },
                _tunerUIApi.updateUI
            );
        } catch (e) {
            console.warn('Tuner: auto-start audio failed (badge will be static):', e && e.message ? e.message : e);
        }
        _installAutoOpenListeners();
    }).catch(e => console.error(e));
    _installAutoOpenListeners();
    window._tunerAutoOpen = {
        tuningIdentityKey: _tuningIdentityKey,
        sessionKey: _autoOpenSessionKey,
        maybeAutoOpenOnTuningChange: _maybeAutoOpenOnTuningChange,
        coveredByPlayerInstrument: _coveredByPlayerInstrument,
        coverageReport: _coverageReport,
        onSongLoading: _onAutoOpenSongLoadingHandler,
        getState() {
            return {
                lastTuningKey: _lastTuningKey,
                lastAutoOpenSessionKey: _lastAutoOpenSessionKey,
                autoOpenDismissedSessionKey: _autoOpenDismissedSessionKey,
                autoOpenGeneration: _autoOpenGeneration,
                enabled: _state.enabled,
            };
        },
        resetState() {
            _lastTuningKey = null;
            _lastAutoOpenSessionKey = null;
            _autoOpenDismissedSessionKey = null;
            _autoOpenGeneration = 0;
        },
        setEnabledForTests(value) {
            _state.enabled = !!value;
        },
    };
    console.log('Tuner plugin loaded. Use window.tuner.toggle() to open.');
})();
