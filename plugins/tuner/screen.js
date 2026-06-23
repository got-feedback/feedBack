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

    function _onAutoOpenSongLoadingHandler() {
        _autoOpenGeneration++;
        _autoOpenDismissedSessionKey = null;
        _lastAutoOpenSessionKey = null;
    }

    async function _maybeAutoOpenOnTuningChange() {
        if (!document.getElementById('player')?.classList.contains('active')) return;

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

        _lastAutoOpenSessionKey = sessionKey;
        try {
            await window.tuner.enable();
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

    async function enable() {
        if (_state.enabled) return;
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

        // Close when clicking outside the panel. Deferred so the badge's
        // opening click doesn't bubble up to the document and fire immediately.
        if (_outsideClickClose) document.removeEventListener('click', _outsideClickClose);
        _outsideClickClose = () => { if (_state.enabled) disable(); };
        setTimeout(() => { if (_outsideClickClose) document.addEventListener('click', _outsideClickClose, { once: true }); }, 0);

        if (window.feedBack && !_onScreenChanged) {
            _onScreenChanged = () => { disable(); };
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
