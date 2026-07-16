import {
    bootstrapPluginsAndUi,
    checkPluginUpdates,
    loadPlugins,
    updatePlugin,
} from './js/plugin-loader.js';
import {
    _autoMatchViz,
    _maybeShowNotationViewHint,
    _populateVizPicker,
    setViz,
} from './js/viz.js';
import {
    exportDiagnostics,
    previewDiagnostics,
} from './js/diagnostics-export.js';
import {
    _confirmDialog,
    _escAttr,
    _isElementVisible,
    _trapFocusInModal,
    esc,
    uiPrompt,
} from './js/dom.js';
import {
    hwcInitSettingsUI,
    initHighwayColors,
} from './js/highway-colors.js';
import {
    displayTuningName,
    displayTuningTargetDetails,
    displayTuningTargets,
    effectiveStringCount,
    isBassArrangement,
    parseRawTuningOffsets,
    songTuningContext,
} from './js/tuning-display.js';
import {
    exportSettings,
    importSettings,
} from './js/settings-io.js';
import { audio } from './js/audio-el.js';
import { S } from './js/player-state.js';
// Side-effect import: the three JUCE shims are IIFEs that install themselves and
// publish through window.*. _resetJuceAudioShimChain is the one binding app.js needs.
import { _resetJuceAudioShimChain } from './js/juce-audio.js';
import {
    _clearResumeSession,
    _hideResumePill,
    _maybeShowResumePill,
    _readResumeSession,
    _snapshotResumeSession,
    resumeLastSession,
} from './js/resume-session.js';

import {
    _applyMastery,
    _applyMasteryAvailability,
    _autoplayExitEnabled,
    _countdownBeforeSongEnabled,
    _curPlaybackSpeed,
    _exitConfirmEnabled,
    _resetPlaybackSpeedForNewSong,
    _showUpNextEnabled,
    _wireSpeedPresetsOnce,
    applySpeedPreset,
    setMastery,
    setSpeed,
} from './js/player-controls.js';

import {
    _cancelCountIn,
    armCreditsHideOnPlay,
    hideCountOverlay,
    hideSongCreditsOverlay,
    holdCreditsThen,
    isCountingIn,
    playClick,
    scheduleCreditsHide,
    showCountOverlay,
    showSongCreditsOverlay,
    startCountIn,
    startSongCountIn,
} from './js/count-in.js';

import {
    _loopMutationGen,
    clearLoop,
    deleteSelectedLoop,
    loadSavedLoop,
    loadSavedLoops,
    loopA,
    loopB,
    saveCurrentLoop,
    setLoop,
    setLoopEnd,
    setLoopStart,
    updateLoopUI,
} from './js/loops.js';

import {
    _buildSectionParents,
    _ensureSectionPracticeBar,
    _hideSectionPracticeBar,
    _installSectionPracticeDrawHook,
    _maybeRefreshSectionPracticeDuration,
    _placeSectionPracticeControlForChrome,
    _resetSectionPracticeLog,
    _scheduleSectionPracticeRetries,
    _sectionPracticeBarContains,
    _sectionPracticeBarIsReady,
    _sectionPracticePopoverOpen,
    _sectionPracticeSourceSections,
    _sectionPracticeStartTime,
    _setSectionPracticeMode,
    _syncSectionPracticeFromLoop,
    _updateSectionPracticeHighlight,
    invalidateParentCount,
    onPhraseNext,
    onPhrasePrev,
    onSectionParentClick,
    onSectionPracticeModeChange,
    onSectionPracticeWholeChange,
    practiceSection,
    renderSectionPracticeBar,
    resetSelection,
    toggleSectionPracticePopover,
} from './js/section-practice.js';
import { configureHost } from './js/host.js';
import { formatTime } from './js/format.js';
import { L } from './js/library-state.js';
import {
    _LIB_FORMAT_KEY,
    _LIB_FORMAT_VALUES,
    _LIB_SORT_KEY,
    _LIB_SORT_VALUES,
    _activeLibraryProviderId,
    _applyLibFiltersToParams,
    _bumpLibNavGeneration,
    _getArrangementNamingMode,
    _lastLibSelected,
    _libNavItems,
    _libScrollOnNextRender,
    _libraryLocalFilename,
    _libraryProviderApi,
    _librarySongArtUrl,
    _librarySongId,
    _librarySyncState,
    _moveSelectionInItems,
    _onHeaderClick,
    _onNamingModeChange,
    _pollScanAndRefresh,
    _providerSupports,
    _readPersistedChoice,
    _removeLibCardsForFilename,
    _renderLibFilterChips,
    _resetLibraryProviderViewState,
    _setLibSelection,
    _setLibrarySyncState,
    _toggleHeader,
    _updateLibFiltersBadge,
    checkScanAndLoad,
    clearLibFilters,
    editBtn,
    filterFavTreeLetter,
    filterFavorites,
    filterLibrary,
    filterTreeLetter,
    fullRescanLibrary,
    goFavPage,
    goFavTreePage,
    goTreePage,
    hideScanBanner,
    libView,
    loadFavorites,
    loadLibrary,
    loadLibraryProviders,
    loadTreeView,
    renderGridCards,
    renderTreeInto,
    rescanLibrary,
    setFavView,
    setLibView,
    setLibraryProvider,
    sortFavorites,
    sortLibrary,
    stopInfiniteScroll,
    toggleAllArtists,
    toggleAllFavoriteArtists,
    toggleFavorite,
    toggleLibFilters,
} from './js/library.js';
import {
    _editModalShouldClose,
    deleteSongFromModal,
    openEditModal,
    saveEditModal,
} from './js/edit-modal.js';
import {
    APP_UPDATE_CHANNELS,
    INSTRUMENT_PATHWAYS,
    _appUpdatesWired,
    _avOffsetMs,
    _avSaveDebounce,
    _currentArrangementName,
    _defaultArrangement,
    _normalizeInstrumentPathway,
    _persistAvOffset,
    _postSetting,
    _settingSaveChain,
    _syncDefaultArrangementSelect,
    handleSliderInput,
    loadSettings,
    nudgeAvOffsetMs,
    persistSetting,
    pinCurrentArrangementDefault,
    saveSettings,
    setAvOffsetMs,
    setInstrumentPathway,
    setupAppUpdates,
    setupWindowOptions,
    syncDefaultArrangementPin,
} from './js/settings.js';
import {
    AUTOPLAY_HOLD_BACKSTOP_MS,
    AUTO_EXIT_GRACE_MS,
    _BRIDGE_RECORD_MIN_MS,
    _acquireWakeLock,
    _autoExitGen,
    _autoExitHeld,
    _autoExitTimer,
    _autoplayBackstop,
    _autoplayGen,
    _autoplayHeld,
    _autoplayHoldToken,
    _autoplayStart,
    _bridgeRecordLast,
    _clearAutoExit,
    _clearAutoplayHold,
    _desktopAwakeGen,
    _desktopAwakeReq,
    _pendingAutostart,
    _playbackApi,
    _playerOriginScreen,
    _recordPlaybackBridge,
    _releaseAutoplay,
    _releaseWakeLock,
    _resolvePlayerOrigin,
    _resultsOverlayVisible,
    _screenWakeLock,
    _settingsOriginScreen,
    _syncDesktopBridge,
    _wakeLockPending,
    _wakeLockRetry,
    _wakeLockWanted,
    artAbortController,
    closeCurrentSong,
    currentFilename,
    playSong,
    showScreen,
} from './js/session.js';
import {
    ShortcutPanel,
    _DEBUG_SHORTCUTS,
    _activePanel,
    _activeSearchInput,
    _defaultPanel,
    _getCurrentContext,
    _gridColumns,
    _handleLibArrowNav,
    _isInsideInteractiveControl,
    _isShortcutActive,
    _isShortcutHelpKey,
    _isShortcutHelpSuppressedTarget,
    _isSpaceKey,
    _isTextInput,
    _modifiersMatch,
    _openShortcutsModal,
    _panels,
    _shortcutDispatchBlocked,
    defaultPanel,
} from './js/shortcuts.js';
// The playback transport. These used to BE app.js — they are imported back now, and the
// four modules that reached for them through the host seam import them directly instead.
import {
    setPlayButtonState, jucePlayer, _audioTime, _audioDuration, _songEventPayload,
    _markPlaybackPaused, _markPlaybackResumed, _emitPlaybackStopped, _emitSongPositionChanged,
    _waitForSongReady, _resetAudioSeekState, _audioSeek, togglePlay, seekBy, audioSeekGen,
} from './js/transport.js';


// Demo analytics — real impl set by demo.js; no-op in normal builds
window.feedBackDemoTrack = window.feedBackDemoTrack ?? null;

// ── Library keyboard navigation ──────────────────────────────────────────
//
// Arrow keys move a single "selected" item among the visible cards
// (grid view) or song rows (tree view). Enter plays the selected
// song. The selected element gets:
//   - native keyboard focus via .focus() so :focus-visible draws the
//     accessible ring (announced by screen readers, follows scroll)
//   - a `.selected` class that persists when focus drifts elsewhere
//     so the user can glance back and still see their place.
//
// Grid columns are inferred from the live computed grid template at
// the moment of navigation, so up/down works correctly across all
// breakpoints (1 / 2 / 3 / 4 cols depending on viewport).


// ── Library ──────────────────────────────────────────────────────────────

const _LIB_PROVIDER_KEY = 'feedBack.libProvider';
// Bumped on filter/sort/view changes so in-flight page fetches can detect
// they've been superseded and skip rendering stale results.


  // cached from /api/library/tuning-names

// ── Folder Library: filter bridge ─────────────────────────────────────────
// Serialises the active lib filter state as URL params so the plugin can pass
// them to /api/plugins/folder_library/tree — the same pattern grid and tree
// views use when sending filter params to their own backend endpoints.
window.feedBackLibFilterParams = function() {
    var p = new URLSearchParams();
    _applyLibFiltersToParams(p);
    return p.toString();
};


// ── Grid View (server-side pagination, infinite scroll) ────────────────

// ── Tree View (server-side) ─────────────────────────────────────────────

window.displayTuningName = displayTuningName;
window.feedBack = window.feedBack || {};
window.slopsmith = window.feedBack;
window.feedBack.displayTuningName = displayTuningName;




window.feedBack.isBassArrangement = isBassArrangement;
window.feedBack.effectiveStringCount = effectiveStringCount;
window.feedBack.songTuningContext = songTuningContext;












window.displayTuningTargets = displayTuningTargets;
window.displayTuningTargetDetails = displayTuningTargetDetails;
window.parseRawTuningOffsets = parseRawTuningOffsets;
window.feedBack.displayTuningTargets = displayTuningTargets;
window.feedBack.displayTuningTargetDetails = displayTuningTargetDetails;
window.feedBack.parseRawTuningOffsets = parseRawTuningOffsets;



// ── App Updates (desktop-only) ───────────────────────────────────────────
// Velopack auto-update controls, rendered as the first block of the Settings
// page. Whole block stays hidden in the plain web app; unhide + wire only
// when the feedBack-desktop bridge (window.feedBackDesktop.update) is
// present. On Linux the block renders but its controls are disabled — the
// desktop reports platform === 'linux' and short-circuits the IPC.

// ── Restart banner (desktop-only) ────────────────────────────────────────
// Subscribes to window.feedBackDesktop.update.onDownloaded and renders a
// persistent banner with a "Restart now" button. Runs once at app boot so a
// download finishing while the user is on a non-Settings screen still pops
// the banner.

function initAppUpdateBanner() {
    const updateApi = window.feedBackDesktop?.update;
    // Same capability gate as setupAppUpdates — the banner needs onDownloaded
    // to subscribe, getStatus to detect pre-existing pending updates on boot,
    // and apply to actually restart from the button. A bridge missing any
    // of these would partially fail; better to no-op cleanly.
    if (!updateApi
        || typeof updateApi.onDownloaded !== 'function'
        || typeof updateApi.getStatus !== 'function'
        || typeof updateApi.apply !== 'function') {
        return;
    }

    const BANNER_ID = 'feedBack-update-banner';

    function renderUpdateBanner(payload) {
        // Avoid stacking duplicate banners if onDownloaded fires more than once.
        if (document.getElementById(BANNER_ID)) return;

        const banner = document.createElement('div');
        banner.id = BANNER_ID;
        banner.setAttribute('role', 'status');
        banner.style.cssText = [
            'position:fixed', 'top:0', 'left:0', 'right:0',
            'z-index:99999', 'padding:10px 16px',
            'background:linear-gradient(90deg,#1e3a8a,#4338ca)',
            'color:#fff', 'font-size:13px',
            'font-family:system-ui,sans-serif',
            'display:flex', 'align-items:center', 'justify-content:space-between',
            'gap:12px', 'box-shadow:0 2px 8px rgba(0,0,0,0.4)',
        ].join(';');

        const text = document.createElement('span');
        const version = payload && payload.version ? ` (${payload.version})` : '';
        text.textContent = `Update downloaded${version} — restart to apply.`;

        const actions = document.createElement('span');
        actions.style.cssText = 'display:flex;gap:8px;align-items:center';

        const restartBtn = document.createElement('button');
        restartBtn.textContent = 'Restart now';
        restartBtn.style.cssText = [
            'padding:4px 12px', 'border-radius:4px',
            'background:#fff', 'color:#1e3a8a', 'border:none',
            'font-weight:600', 'cursor:pointer', 'font-size:13px',
        ].join(';');
        restartBtn.addEventListener('click', async () => {
            restartBtn.disabled = true;
            restartBtn.textContent = 'Restarting…';
            try {
                // apply() can resolve with { status: 'error' } instead of
                // throwing; only re-enable the button on that path.
                const result = await updateApi.apply();
                if (result?.status === 'error') {
                    console.warn('[updater] apply returned error:', result.message || 'unknown');
                    restartBtn.disabled = false;
                    restartBtn.textContent = 'Restart now';
                }
            } catch (e) {
                console.warn('[updater] apply failed:', e);
                restartBtn.disabled = false;
                restartBtn.textContent = 'Restart now';
            }
        });

        const dismissBtn = document.createElement('button');
        dismissBtn.textContent = 'Later';
        dismissBtn.setAttribute('aria-label', 'Dismiss update banner');
        dismissBtn.style.cssText = [
            'padding:4px 10px', 'border-radius:4px',
            'background:transparent', 'color:#fff',
            'border:1px solid rgba(255,255,255,0.3)',
            'cursor:pointer', 'font-size:13px',
        ].join(';');
        dismissBtn.addEventListener('click', () => banner.remove());

        actions.appendChild(restartBtn);
        actions.appendChild(dismissBtn);
        banner.appendChild(text);
        banner.appendChild(actions);

        const insert = () => {
            if (document.body) document.body.appendChild(banner);
            else document.addEventListener('DOMContentLoaded', () => document.body.appendChild(banner), { once: true });
        };
        insert();
    }

    try {
        updateApi.onDownloaded((payload) => {
            try { renderUpdateBanner(payload); }
            catch (e) { console.warn('[updater] renderUpdateBanner failed:', e); }
        });
    } catch (e) {
        console.warn('[updater] onDownloaded subscribe failed:', e);
    }

    // Catch pre-existing pending updates (downloaded in a previous session,
    // or restored on launch). onDownloaded only fires for downloads that
    // complete in the current session, so do an explicit status check too.
    try {
        void Promise.resolve(updateApi.getStatus()).then((status) => {
            // Render the banner for any 'downloaded' status; the version
            // string is best-effort — renderUpdateBanner() already drops the
            // "(vX.Y.Z)" suffix when none is supplied, so an update reported
            // without pending.version still surfaces the restart prompt.
            if (status && status.status === 'downloaded') {
                renderUpdateBanner({ version: status.pending?.version, channel: status.channel });
            }
        }).catch((e) => {
            console.warn('[updater] getStatus on init failed:', e);
        });
    } catch (e) {
        console.warn('[updater] getStatus on init threw:', e);
    }
}

// Open a native OS folder picker via the Electron bridge (desktop only) and
// stash the chosen path into the DLC input. User still has to hit Save.
async function pickDlcFolder() {
    if (!window.feedBackDesktop?.pickDirectory) return;
    const path = await window.feedBackDesktop.pickDirectory();
    if (path) document.getElementById('dlc-path').value = path;
}

document.getElementById('arr-select')?.addEventListener('change', syncDefaultArrangementPin);

async function uploadSongs(fileList) {
    if (!fileList || fileList.length === 0) return;
    const all = Array.from(fileList);
    // Optional UI element — only present when on the Settings screen.
    // The navbar entry triggers uploads from any screen, where these aren't.
    const status = document.getElementById('rescan-status');
    const setStatus = (s) => { if (status) status.textContent = s; };

    // Client-side extension filter so we don't waste a round-trip on
    // clearly-invalid picks. The server validates again.
    const failures = [];
    const files = [];
    for (const f of all) {
        const lower = f.name.toLowerCase();
        if (lower.endsWith('.feedpak') || lower.endsWith('.sloppak')) {
            files.push(f);
        } else {
            failures.push(`${f.name}: only .feedpak or .sloppak accepted`);
        }
    }
    if (files.length === 0) {
        if (failures.length) alert(failures.join('\n'));
        return;
    }

    // The backend caps batches at _MAX_UPLOAD_FILES (50). Chunk if needed so a
    // big drag-and-drop of an album folder still works end-to-end.
    const BATCH = 50;
    const chunks = [];
    for (let i = 0; i < files.length; i += BATCH) chunks.push(files.slice(i, i + BATCH));

    let uploaded = 0;

    const postChunk = async (chunk, overwrite) => {
        const form = new FormData();
        for (const f of chunk) form.append('file', f);
        const url = '/api/songs/upload' + (overwrite ? '?overwrite=1' : '');
        const resp = await fetch(url, { method: 'POST', body: form });
        if (!resp.ok) {
            let data = {};
            try { data = await resp.json(); } catch (_) {}
            // Whole-request rejection (DLC misconfig, payload too large, etc.).
            throw new Error(data.error || resp.statusText || `HTTP ${resp.status}`);
        }
        const body = await resp.json();
        return body.results || [];
    };

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const label = chunks.length > 1
            ? `Uploading batch ${i + 1}/${chunks.length} (${chunk.length} files)...`
            : `Uploading ${chunk.length} file${chunk.length === 1 ? '' : 's'}...`;
        setStatus(label);

        let results;
        try {
            results = await postChunk(chunk, false);
        } catch (e) {
            for (const f of chunk) failures.push(`${f.name}: ${e.message}`);
            continue;
        }

        // Index file objects by name so a follow-up overwrite request can
        // resend the same blobs. Names within a chunk are unique on disk
        // (DLC dir is flat for this purpose), but two distinct user picks
        // could share a name — Map.set keeps the last one, which matches
        // server-side last-write-wins semantics.
        const byName = new Map(chunk.map(f => [f.name, f]));

        const conflicts = [];
        for (const r of results) {
            if (r.status === 'ok') {
                uploaded++;
            } else if (r.status === 'exists') {
                conflicts.push(r);
            } else {
                failures.push(`${r.filename}: ${r.error || 'upload failed'}`);
            }
        }

        if (conflicts.length > 0) {
            const names = conflicts.map(c => c.filename);
            const preview = names.slice(0, 5).join(', ') + (names.length > 5 ? `, +${names.length - 5} more` : '');
            const ok = confirm(
                `${conflicts.length} file${conflicts.length === 1 ? '' : 's'} already exist in your DLC folder:\n${preview}\n\nOverwrite?`
            );
            if (!ok) {
                for (const c of conflicts) failures.push(`${c.filename}: skipped (already exists)`);
                continue;
            }
            const retryFiles = conflicts
                .map(c => byName.get(c.filename))
                .filter(Boolean);
            setStatus(`Overwriting ${retryFiles.length} file${retryFiles.length === 1 ? '' : 's'}...`);
            let retryResults;
            try {
                retryResults = await postChunk(retryFiles, true);
            } catch (e) {
                for (const f of retryFiles) failures.push(`${f.name}: ${e.message}`);
                continue;
            }
            for (const r of retryResults) {
                if (r.status === 'ok') uploaded++;
                else failures.push(`${r.filename}: ${r.error || 'upload failed'}`);
            }
        }
    }

    if (failures.length === 0) {
        setStatus(`Uploaded ${uploaded} file${uploaded === 1 ? '' : 's'}. Scanning...`);
    } else {
        // Denominator is the full user selection (`all.length`), not just the
        // post-filter `files.length`. Otherwise picking one valid file plus
        // one `.txt` would show "Uploaded 1/1" with a failure listed below,
        // overstating the success rate.
        const total = all.length;
        const msg = `Uploaded ${uploaded}/${total}. ${failures.length} failed:\n` + failures.join('\n');
        alert(msg);
        setStatus(`Uploaded ${uploaded}/${total}, ${failures.length} failed.`);
    }
    if (uploaded > 0) {
        // Server kicked off a background scan after the batch finished; poll
        // for completion and refresh the library when it finishes.
        _pollScanAndRefresh(status);
    }
}

// ── Plugin functions loaded dynamically from plugin screen.js files ──────
// (searchCF, installCF, loginCF, searchUG, buildFromUG, etc.)

// ── Retune ───────────────────────────────────────────────────────────────
function retuneSong(filename, title, tuning, target) {
    target = target || 'E Standard';
    if (!confirm(`Convert "${title}" from ${tuning} to ${target}?`)) return;

    // Show modal overlay
    const modal = document.createElement('div');
    modal.id = 'retune-modal';
    modal.className = 'fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm';
    modal.innerHTML = `
        <div class="bg-dark-700 border border-gray-700 rounded-2xl p-8 w-full max-w-md mx-4 shadow-2xl">
            <h3 class="text-lg font-bold text-white mb-1">Converting to ${target}</h3>
            <p class="text-sm text-gray-400 mb-5">${title}</p>
            <div class="progress-bar mb-3"><div class="fill" id="retune-bar" style="width:0%"></div></div>
            <p class="text-xs text-gray-500" id="retune-stage">Connecting...</p>
        </div>`;
    document.body.appendChild(modal);

    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/retune?filename=${encodeURIComponent(decodeURIComponent(filename))}&target=${encodeURIComponent(target)}`);
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.progress !== undefined) {
            document.getElementById('retune-bar').style.width = msg.progress + '%';
        }
        if (msg.stage) {
            document.getElementById('retune-stage').textContent = msg.stage;
        }
        if (msg.done) {
            modal.querySelector('.bg-dark-700').innerHTML = `
                <div class="text-center">
                    <div class="text-3xl mb-3">✓</div>
                    <h3 class="text-lg font-bold text-white mb-1">Done!</h3>
                    <p class="text-sm text-gray-400 mb-5">${msg.filename}</p>
                    <button onclick="document.getElementById('retune-modal').remove();loadLibrary()"
                        class="bg-accent hover:bg-accent-light px-6 py-2 rounded-xl text-sm font-semibold text-white transition">OK</button>
                </div>`;
        }
        if (msg.error) {
            modal.querySelector('.bg-dark-700').innerHTML = `
                <div class="text-center">
                    <div class="text-3xl mb-3">✕</div>
                    <h3 class="text-lg font-bold text-red-400 mb-1">Failed</h3>
                    <p class="text-sm text-gray-400 mb-5">${msg.error}</p>
                    <button onclick="document.getElementById('retune-modal').remove()"
                        class="bg-dark-600 hover:bg-dark-500 px-6 py-2 rounded-xl text-sm text-gray-300 transition">Close</button>
                </div>`;
        }
    };
    ws.onerror = () => {
        modal.querySelector('.bg-dark-700').innerHTML = `
            <div class="text-center">
                <p class="text-red-400 mb-4">Connection lost</p>
                <button onclick="document.getElementById('retune-modal').remove()"
                    class="bg-dark-600 px-6 py-2 rounded-xl text-sm text-gray-300">Close</button>
            </div>`;
    };
}

function _applyPreservePitch(el) {
    if (!el) return;
    if ('preservesPitch' in el) el.preservesPitch = true;
    if ('mozPreservesPitch' in el) el.mozPreservesPitch = true;
    if ('webkitPreservesPitch' in el) el.webkitPreservesPitch = true;
}
_applyPreservePitch(audio);

// In FeedBack Desktop, WASAPI Exclusive Mode locks the audio device so Chromium
// cannot play through it. When window._juceMode is true, song audio is routed
// through the JUCE backing track player instead of the HTML5 <audio> element.
window._juceMode = false;
window._juceAudioUrl = null;
window.jucePlayer = jucePlayer;

// ── Engine start/stop → re-route song audio (HTML5 ⇄ JUCE) ──────────────────
// window._juceMode is otherwise decided once, at song-load time (window.highway.js),
// from isAudioRunning(). If the JUCE audio engine is started or stopped *after*
// a song is already loaded (e.g. the user presses CHAIN / AMP), that decision
// goes stale: the song stays on the HTML5 <audio> element while the engine
// grabs the device in exclusive mode (audible guitar, silent song), or it stays
// on a dead JUCE backing transport. This watcher migrates the loaded song
// between the two paths whenever the engine's running state changes, preserving
// playback position and play/pause state.
// [asio-diag] global error tap: the 2026-07-11 tester log showed an uncaught
// SyntaxError with no source location and the routing watcher/feeder never
// installing — an error event carries filename:line even for parse errors in
// other scripts, which console output does not. Gated on the desktop --debug
// flag via window._asioDiagEnabled (installed just below; resolves async, so
// errors thrown in the first ~second of a debug run may be missed — the
// stale-cache class of failure reproduces on every later tick anyway).
window.addEventListener('error', (e) => {
    if (!window._asioDiagEnabled?.()) return;
    console.warn('[asio-diag] uncaught-error:', e.message,
        'at', (e.filename || '<unknown>') + ':' + (e.lineno || 0) + ':' + (e.colno || 0));
});
window.addEventListener('unhandledrejection', (e) => {
    if (!window._asioDiagEnabled?.()) return;
    const r = e.reason;
    console.warn('[asio-diag] unhandled-rejection:',
        (r && (r.name + ': ' + r.message)) || String(r));
});




// Plugin context API — lightweight event bus for plugin integration
// Preserve any namespace attached by earlier-loaded scripts (e.g.
// diagnostics.js, feedBack#166) so reassigning the root doesn't drop
// their public APIs. Only `feedBack.diagnostics` exists today, but
// the snapshot pattern is intentional: it keeps app.js the
// authoritative owner of the EventTarget while letting other modules
// hang their surfaces off the same namespace without coordinating
// load order.
const _feedBackExisting = (typeof window.feedBack === 'object' && window.feedBack !== null) ? window.feedBack : null;
const _feedBackBus = (_feedBackExisting
    && typeof _feedBackExisting.addEventListener === 'function'
    && typeof _feedBackExisting.removeEventListener === 'function'
    && typeof _feedBackExisting.dispatchEvent === 'function')
    ? _feedBackExisting
    : new EventTarget();
window.feedBack = Object.assign(_feedBackBus, {
    currentSong: null,
    isPlaying: false,
    _navParams: {},
    navigate(screenId, params) {
        this._navParams = params || {};
        showScreen(screenId);
    },
    getNavParams() {
        const p = this._navParams;
        this._navParams = {};
        return p;
    },
    emit(event, detail) {
        this.dispatchEvent(new CustomEvent(event, { detail }));
    },
    on(event, fn, options) {
        this.addEventListener(event, fn, options);
    },
    off(event, fn, options) { this.removeEventListener(event, fn, options); },
    // Loop API — plugins should never reach for #btn-loop-* directly.
    // The script-scope `setLoop` and `clearLoop` are hoisted so these
    // method bodies resolve them lexically; `getLoop` reads the live
    // loopA/loopB bindings at call time.
    seek(seconds, reason, options) {
        _recordPlaybackBridge('playback.window-feedBack-transport', 'window.feedBack.seek', reason || 'plugin-command');
        return _audioSeek(seconds, reason || 'plugin-command');
    },
    setLoop(a, b, options) {
        _recordPlaybackBridge('playback.loop-api', 'window.feedBack.setLoop', options && options.reason || 'plugin-command');
        return setLoop(a, b, options);
    },
    clearLoop(options) {
        _recordPlaybackBridge('playback.loop-api', 'window.feedBack.clearLoop', options && options.reason || 'plugin-command');
        clearLoop(options);
    },
    getLoop(options) {
        _recordPlaybackBridge('playback.loop-api', 'window.feedBack.getLoop', options && options.reason || 'plugin-command');
        return { loopA, loopB };
    },
});
if (_feedBackExisting && _feedBackExisting !== window.feedBack) {
    for (const key of Object.keys(_feedBackExisting)) {
        if (!(key in window.feedBack)) {
            window.feedBack[key] = _feedBackExisting[key];
        }
    }
}
window.feedback = window.feedBack;
window.slopsmith = window.feedback;

function _currentPlaybackSnapshot() {
    const song = window.feedBack && window.feedBack.currentSong || null;
    const time = _audioTime();
    return {
        currentTime: Number.isFinite(time) ? time : null,
        mediaTime: Number.isFinite(time) ? time : null,
        chartTime: (typeof window.highway?.getTime === 'function') ? window.highway.getTime() : null,
        duration: Number.isFinite(_audioDuration()) ? _audioDuration() : (song && song.duration) || null,
        playbackRate: window._juceMode ? (window.jucePlayer && window.jucePlayer._speed || 1) : audio.playbackRate,
        isPlaying: S.isPlaying,
        readiness: song ? 'ready' : 'idle',
        routeKind: window._juceMode ? 'desktop-native' : 'browser-media',
        routeState: song || audio.src || window._juceAudioUrl ? 'active' : 'unavailable',
        loopA,
        loopB,
        loop: loopA !== null && loopB !== null ? { startTime: loopA, endTime: loopB, enabled: true, state: 'active' } : { enabled: false, state: 'inactive' },
        currentSong: song ? {
            targetId: song.filename ? `target-${String(song.filename).length}-${String(song.arrangementIndex ?? song.arrangement ?? '').length}` : undefined,
            sourceKind: song.format || 'local',
            format: song.format || 'unknown',
            arrangementRef: song.arrangementIndex != null ? `arrangement-${song.arrangementIndex}` : song.arrangement,
            localDisplay: {
                title: song.title,
                artist: song.artist,
                arrangement: song.arrangementSmartName || song.arrangement,
            },
        } : null,
    };
}

function _installPlaybackTransportAdapter() {
    const playback = _playbackApi();
    if (!playback || typeof playback.registerTransportAdapter !== 'function') return;
    playback.registerTransportAdapter({
        inspect() {
            return _currentPlaybackSnapshot();
        },
        async start(args) {
            const target = args && args.target || {};
            const filename = target.filename || target.id || target.songKey || (target.localDisplay && target.localDisplay.filename) || currentFilename;
            if (!filename) throw new Error('No playback filename available');
            // playSong() and the highway WS decodeURIComponent the filename, so a
            // raw name with a literal '%' (e.g. "Song 50%.sloppak") would throw
            // URIError. Normalize to the encoded form playSong expects: pass it
            // through if it already decodes cleanly, otherwise encode it.
            let playbackFilename = filename;
            try { decodeURIComponent(playbackFilename); }
            catch (_) { playbackFilename = encodeURIComponent(filename); }
            const shouldSeekStart = Number.isFinite(Number(args && args.startTime));
            const expectedSeekGen = audioSeekGen() + 1;
            const ready = shouldSeekStart ? _waitForSongReady(expectedSeekGen) : null;
            await playSong(playbackFilename, args && args.arrangement, { bridge: false });
            const becameReady = ready ? await ready : true;
            if (shouldSeekStart && !becameReady) {
                throw new Error('Playback did not become ready before applying startTime');
            }
            if (shouldSeekStart) {
                await _audioSeek(Number(args.startTime), 'playback-start');
            }
            return _currentPlaybackSnapshot();
        },
        async pause() {
            const wasPlaying = S.isPlaying;
            if (!window._juceMode && wasPlaying) {
                S.isPlaying = false;
                window.feedBack.isPlaying = false;
                audio.pause();
                _markPlaybackPaused();
            } else {
                if (window._juceMode) await jucePlayer.pause();
                else audio.pause();
                if (wasPlaying) _markPlaybackPaused();
                else { S.isPlaying = false; window.feedBack.isPlaying = false; setPlayButtonState(false); }
            }
            return _currentPlaybackSnapshot();
        },
        async resume() {
            if (window._juceMode) {
                const started = await jucePlayer.play();
                if (!started) return { unavailable: true, reason: 'desktop backing transport unavailable' };
                _markPlaybackResumed();
            } else {
                await audio.play();
                S.isPlaying = true;
                window.feedBack.isPlaying = true;
                setPlayButtonState(true);
            }
            return _currentPlaybackSnapshot();
        },
        async stop() {
            const stopTime = _audioTime();
            const hadPlayableSong = !!audio.src || !!window._juceAudioUrl || S.isPlaying;
            const wasPlaying = S.isPlaying;
            if (window._juceMode) await jucePlayer.stop().catch(() => {});
            if (!window._juceMode && wasPlaying) {
                S.isPlaying = false;
                window.feedBack.isPlaying = false;
                audio.pause();
                _markPlaybackPaused();
            } else {
                // HTML5 only. In JUCE mode jucePlayer.stop() already stopped the
                // engine; the audio.pause() shim would just queue a redundant
                // jucePlayer.pause() and a duplicate (or, when not playing,
                // spurious) song:pause.
                if (!window._juceMode) audio.pause();
                if (wasPlaying) _markPlaybackPaused();
                else { S.isPlaying = false; window.feedBack.isPlaying = false; setPlayButtonState(false); }
            }
            if (hadPlayableSong) _emitPlaybackStopped(stopTime);
            return _currentPlaybackSnapshot();
        },
        seek({ time, reason }) {
            const seconds = Number(time);
            if (!Number.isFinite(seconds) || seconds < 0) {
                throw new Error(`Invalid seek time: ${time}`);
            }
            return _audioSeek(seconds, reason || 'playback-command');
        },
        setLoop({ startTime, endTime }) {
            return setLoop(startTime, endTime, { emitTransportEvent: false });
        },
        clearLoop() {
            clearLoop({ emitTransportEvent: false });
            return _currentPlaybackSnapshot();
        },
    });
}

_installPlaybackTransportAdapter();

// Initialise volume from persisted preference (matches lefty / invertHighway /
// renderScale / showLyrics convention). The mixer popover (audio-mixer.js)
// owns the UI surface; this just hydrates audio.volume on boot.
function _readSongVolume() {
    try {
        const stored = parseFloat(localStorage.getItem('volume'));
        return Number.isFinite(stored) ? Math.min(100, Math.max(0, stored)) : 80;
    } catch (e) {
        return 80;
    }
}
audio.volume = _readSongVolume() / 100;

function _adjustSongVolume(delta) {
    const audioApi = window.feedBack?.audio;
    if (!audioApi) return;
    const current = audioApi.readSongVolume?.() ?? 80;
    const next = Math.max(0, Math.min(100, Math.round(current + delta)));
    const songFader = audioApi.getFaders?.().find(f => f.id === 'song');
    if (songFader) songFader.setValue(next);
}

// Re-sync audio.volume from the persisted setting whenever a new source
// finishes loading metadata. Belt + suspenders — some combinations of plugin
// audio-graph routing and media-element swaps reset audio.volume to 1.0
// (feedBack#54). Delegates to audio-mixer's readSongVolume when loaded so
// the in-memory fallback (for storage-blocked contexts) is authoritative.
audio.addEventListener('loadedmetadata', () => {
    _applyPreservePitch(audio);
    const applySongVolume = window.feedBack?.audio?.applySongVolume;
    if (typeof applySongVolume === 'function') {
        void applySongVolume();
    } else {
        audio.volume = (window.feedBack?.audio?.readSongVolume?.() ?? _readSongVolume()) / 100;
    }
});

// Debug audio issues
audio.addEventListener('pause', () => {
    // The JUCE engine-reroute watcher pauses the element on purpose mid-migration
    // (and the src='' it does fires a trailing async pause too); don't flag those
    // as unexpected — the watcher holds window._juceRerouteInProgress across it.
    if (S.isPlaying && !window._juceRerouteInProgress) {
        console.log('Audio paused unexpectedly at', audio.currentTime.toFixed(1));
    }
});
audio.addEventListener('error', (e) => {
    // Ignore errors from empty src (happens during song switch cleanup)
    if (!audio.src || audio.src === window.location.href) return;
    console.error('Audio error:', audio.error?.code, audio.error?.message);
});
audio.addEventListener('stalled', () => console.log('Audio stalled at', audio.currentTime.toFixed(1)));
audio.addEventListener('waiting', () => console.log('Audio waiting/buffering at', audio.currentTime.toFixed(1)));
audio.addEventListener('ended', () => {
    console.log('Audio ended'); S.isPlaying = false;
    setPlayButtonState(false);
    window.feedBack.isPlaying = false;
    window.feedBack.emit('song:ended', _songEventPayload());
});
audio.addEventListener('timeupdate', () => {
    _emitSongPositionChanged(audio.currentTime, audio.duration || null);
});
audio.addEventListener('play', () => {
    // During a JUCE engine reroute the element is paused/played as a transparent
    // migration step — playback genuinely continues, so don't emit song:play or
    // flip feedBack.isPlaying (the watcher keeps the canonical state itself).
    if (window._juceRerouteInProgress) return;
    window.feedBack.isPlaying = true;
    const payload = _songEventPayload();
    window.feedBack.emit('song:play', payload);
    window.feedBack.emit('song:resume', payload);
});
audio.addEventListener('pause', () => {
    if (!S.isPlaying) return;
    // Same as above: suppress the song:pause emitted by a reroute's deliberate
    // audio.pause() — the migration is transparent to plugin play-state.
    if (window._juceRerouteInProgress) return;
    window.feedBack.isPlaying = false;
    window.feedBack.emit('song:pause', _songEventPayload());
});

window.feedBack.on('song:play', _acquireWakeLock);
window.feedBack.on('song:resume', _acquireWakeLock);
window.feedBack.on('song:pause', _releaseWakeLock);
window.feedBack.on('song:ended', _releaseWakeLock);
window.feedBack.on('song:stop', _releaseWakeLock);
// A screen wake lock is auto-released whenever the page is hidden; re-sync the
// desktop bridge (off while hidden) and re-acquire the browser lock when we
// become visible again if a song is still playing.
document.addEventListener('visibilitychange', () => {
    _syncDesktopBridge();
    if (document.visibilityState === 'visible' && _wakeLockWanted) {
        _acquireWakeLock();
    }
});

// Settings checkbox setter (onchange="setAutoplayExit(this.checked)").
window.setAutoplayExit = function (on) {
    try { localStorage.setItem('autoplayExit', on ? '1' : '0'); } catch (_) { /* private mode */ }
    const el = document.getElementById('setting-autoplay-exit');
    if (el && el.checked !== !!on) el.checked = !!on;
};
// Read-only view for plugins (e.g. a scoring plugin deciding whether to
// auto-return after its results screen closes).
Object.defineProperty(window.feedBack, 'autoplayExit', {
    get: _autoplayExitEnabled, configurable: true,
});

// Settings checkbox setter (onchange="setShowUpNext(this.checked)").
window.setShowUpNext = function (on) {
    try { localStorage.setItem('showUpNext', on ? '1' : '0'); } catch (_) { /* private mode */ }
    const el = document.getElementById('setting-show-upnext');
    if (el && el.checked !== !!on) el.checked = !!on;
    // Reflect immediately when disabling mid-playback; the chrome's rAF
    // loop (~6 Hz) re-shows it when re-enabled and a section is upcoming.
    if (!on) {
        const pill = document.getElementById('v3-upnext');
        if (pill) pill.classList.add('hidden');
    }
};
// Read-only view for the player chrome (and any plugin) to gate the pill.
Object.defineProperty(window.feedBack, 'showUpNext', {
    get: _showUpNextEnabled, configurable: true,
});

// Settings checkbox setter (onchange="setCountdownBeforeSong(this.checked)").
// Writes localStorage for the synchronous read above AND persists to the
// server so it survives a reload / rides along in the settings export bundle.
window.setCountdownBeforeSong = function (on) {
    try { localStorage.setItem('countdownBeforeSong', on ? '1' : '0'); } catch (_) { /* private mode */ }
    const el = document.getElementById('setting-countdown-before-song');
    if (el && el.checked !== !!on) el.checked = !!on;
    persistSetting('countdown_before_song', !!on);
};
// One-shot launcher override for the player's return destination.
window.feedBack.setReturnScreen = function (id) {
    window.feedBack._nextReturnScreen = id || null;
};
window.resumeLastSession = resumeLastSession;
if (window.feedBack) window.feedBack.resumeLastSession = resumeLastSession;

// Consume a pending resume once the chart is ready: restore speed, seek to the
// saved position, then (if autoplay is on) start from there. playSong() does
// NOT arm autostart for a resume load, so the two never fight over playback.
window.feedBack.on('song:ready', () => {
    const pend = S.pendingResume;
    if (!pend) return;
    S.pendingResume = null;
    try {
        if (pend.speed && pend.speed > 0) {
            const slider = document.getElementById('speed-slider');
            if (slider) slider.value = String(Math.round(pend.speed * 100));
            setSpeed(pend.speed);
        }
    } catch (_) { /* speed restore is best-effort */ }
    Promise.resolve(_audioSeek(Math.max(0, Number(pend.position) || 0), 'session-resume'))
        .then(() => { if (_autoplayExitEnabled() && !S.isPlaying) return togglePlay(); })
        .catch((err) => console.warn('[app] resume failed:', err));
});

// A song that finishes on its own has nothing to resume — and we never want to
// offer "resume" for a song the user just completed.
window.feedBack.on('song:ended', _clearResumeSession);


if (window.feedBack) window.feedBack._maybeShowResumePill = _maybeShowResumePill;

// Exposed for tests/debugging (mirrors window._panels / _getCurrentContext).
window._snapshotResumeSession = _snapshotResumeSession;
window._readResumeSession = _readResumeSession;
window._clearResumeSession = _clearResumeSession;

// Drive the pill off screen transitions (hide over the player, offer it
// elsewhere) plus a one-shot check on first load for a prior-session snapshot.
window.feedBack.on('screen:changed', (ev) => {
    const id = (ev && ev.detail && ev.detail.id) || (ev && ev.id);
    if (id === 'player') _hideResumePill();
    else _maybeShowResumePill();
});
// `defer` runs this at readyState 'interactive' — later scripts have not
// evaluated yet, so wait for DOMContentLoaded (see static/v3/index.html).
if (document.readyState !== 'complete') {
    document.addEventListener('DOMContentLoaded',
        () => { try { _maybeShowResumePill(); } catch (_) {} }, { once: true });
} else {
    try { _maybeShowResumePill(); } catch (_) {}
}

// Editor → Highway handoff (Editor ⇄ 3D Highway region round-trip). The
// editor's "Loop in 3D" button stashes a pending loop + return context, then
// calls playSong(). Once the chart is ready (playSong's own clearLoop() has
// already run, so the loop won't be wiped), arm the loop over the selected
// region and start playback so the user lands inside the loop directly.
window.feedBack.on('song:ready', () => {
    _updateEditRegionBtn();
    const pend = window._pendingHighwayLoop;
    if (!pend) return;
    // Only apply to the song it was set for — a cancelled/failed handoff
    // must not arm a stale loop on an unrelated song loaded later.
    const want = pend.returnCtx && pend.returnCtx.filename;
    if (want && currentFilename && want !== currentFilename) return;
    window._pendingHighwayLoop = null;
    window._highwayReturnCtx = pend.returnCtx || null;
    Promise.resolve(setLoop(pend.a, pend.b))
        .then((ok) => { if (ok && !S.isPlaying) return togglePlay(); })
        .catch((err) => console.warn('[app] loop-in-3d apply failed:', err));
    _updateEditRegionBtn();
});

// Generation token + safety-timeout handle for changeArrangement's
// aria-busy gate. Module-scoped so a newer invocation cancels the
// previous one's pending timeout (and its _onReady callback bails when
// the gen has moved on) rather than clearing aria-busy for itself.
let _arrBusyGen = 0;
let _arrBusyTimeout = null;

async function changeArrangement(index) {
    if (currentFilename) {
        // Tear down any pending fresh-load credits before switching: the
        // no-count-in hold timer would otherwise fire togglePlay() against the
        // incoming (still-loading) arrangement. hideSongCreditsOverlay() clears
        // the timer, the song:play listener, and the overlay node.
        hideSongCreditsOverlay();
        window.feedBack.emit('song:arrangement-changed', { filename: currentFilename, arrangement: index });
        const wasPlaying = S.isPlaying;
        const time = _audioTime();
        if (S.isPlaying) {
            if (window._juceMode) await jucePlayer.pause();
            else audio.pause();
            S.isPlaying = false;
        }

        // Audio is paused, but the play button is intentionally left
        // showing its pre-load state to avoid flicker if auto-resume
        // succeeds. Tell assistive tech to wait until the load +
        // seek-restore + auto-resume settles before re-announcing the
        // button so screen readers don't briefly advertise stale state.
        // Pair with a safety timeout so a websocket/server failure that
        // never reaches `ready` can't leave the button perpetually busy.
        const myGen = ++_arrBusyGen;
        const playBtn = document.getElementById('btn-play');
        if (playBtn) playBtn.setAttribute('aria-busy', 'true');
        if (_arrBusyTimeout !== null) clearTimeout(_arrBusyTimeout);
        _arrBusyTimeout = setTimeout(() => {
            if (myGen !== _arrBusyGen) return;
            _arrBusyTimeout = null;
            const b = document.getElementById('btn-play');
            if (b) b.removeAttribute('aria-busy');
        }, 30000);

        // Show loading overlay
        let overlay = document.getElementById('arr-loading');
        if (overlay) overlay.remove();
        overlay = document.createElement('div');
        overlay.id = 'arr-loading';
        overlay.className = 'fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm';
        overlay.innerHTML = `
            <div class="bg-dark-700 border border-gray-700 rounded-2xl p-6 w-72 text-center shadow-2xl">
                <div class="text-sm text-gray-300 mb-3">Loading arrangement...</div>
                <div class="progress-bar"><div class="fill" style="width:30%;animation:pulse 1s infinite"></div></div>
            </div>`;
        document.body.appendChild(overlay);

        // Set callback for when data is ready. Capture the function ref
        // so a stale older invocation firing after a newer changeArrangement
        // has installed its own callback can't clobber the newer one.
        const myCallback = async () => {
            // Bail in full if this invocation has been superseded. The newer
            // changeArrangement owns the overlay (same id), its own _onReady,
            // and the aria-busy gate; this old callback must not touch any
            // of them.
            if (myGen !== _arrBusyGen) return;
            const ol = document.getElementById('arr-loading');
            if (ol) ol.remove();
            const clearBusy = () => {
                // Double-checked because a newer invocation could land
                // during the await below.
                if (myGen !== _arrBusyGen) return;
                if (_arrBusyTimeout !== null) {
                    clearTimeout(_arrBusyTimeout);
                    _arrBusyTimeout = null;
                }
                const b = document.getElementById('btn-play');
                if (b) b.removeAttribute('aria-busy');
            };
            const clearMyCallback = () => {
                // Only null out if the slot still points at us; a newer
                // invocation may have replaced it during the await.
                if (window.highway._onReady === myCallback) window.highway._onReady = null;
            };
            const r = await _audioSeek(time, 'arrangement-restore');
            // Don't auto-resume on cancel OR off-target landing — same
            // 50 ms tolerance as loop-wrap / loop-set. Resuming play from
            // a different position than the user's previous play position
            // would be jarring; better to leave them at the post-seek
            // (likely close-but-not-equal) position without auto-play.
            if (!r.completed || Math.abs(r.to - time) > 0.05) {
                // changeArrangement paused audio at entry (line 3032) but
                // didn't update the button or emit song:pause — those were
                // meant to be no-ops if the auto-resume succeeded. On
                // abort, sync the transport: button -> 'Play',
                // sm.isPlaying = false, emit song:pause so plugins see the
                // paused state.
                if (wasPlaying) {
                    setPlayButtonState(false);
                    if (window.feedBack) {
                        window.feedBack.isPlaying = false;
                        window.feedBack.emit('song:pause', _songEventPayload());
                    }
                }
                clearBusy();
                clearMyCallback();
                return;
            }
            if (wasPlaying) {
                if (window._juceMode) {
                    const started = await jucePlayer.play();
                    if (started) {
                        S.isPlaying = true;
                        window.feedBack.isPlaying = true;
                        const payload = _songEventPayload();
                        window.feedBack.emit('song:play', payload);
                        window.feedBack.emit('song:resume', payload);
                    }
                } else audio.play().then(() => { S.isPlaying = true; }).catch(() => {});
            }
            clearBusy();
            clearMyCallback();
        };
        window.highway._onReady = myCallback;

        // Reset the Section Practice bar for the incoming arrangement, mirroring
        // playSong(): different arrangements have different section markers, so
        // the old chips/labels and active-parent index must not carry over.
        // _hideSectionPracticeBar() clears the chips (bar becomes "not ready"),
        // so the draw hook re-renders fresh once the new arrangement's sections
        // arrive — even when the new arrangement happens to have the same parent
        // count. The A-B loop itself is left intact (time-based, song-global).
        _hideSectionPracticeBar();
        _resetSectionPracticeLog();
        invalidateParentCount();

        window.highway.reconnect(currentFilename, index);
        window.feedBack.emit('arrangement:changed', { index, filename: currentFilename });
    }
}

// Restart the current song from the beginning (or from loop A when an A–B
// loop is armed). Uses the canonical _audioSeek funnel only — never touches
// audio.currentTime directly and never reloads via playSong().
async function restartCurrentSong() {
    _cancelCountIn();
    let loopA = null;
    let loopB = null;
    if (window.feedBack && typeof window.feedBack.getLoop === 'function') {
        try {
            const loop = window.feedBack.getLoop();
            if (loop && typeof loop === 'object') {
                loopA = loop.loopA;
                loopB = loop.loopB;
            }
        } catch (_) { /* host misbehaviour — treat as no loop */ }
    }
    const hasLoop = loopA != null && loopB != null;
    const target = hasLoop ? loopA : 0;
    const r = await _audioSeek(target, 'song-restart');
    if (!r.completed) return false;
    if (hasLoop) {
        // Verify the seek actually landed at loop A (JUCE may clamp / HTML5 may
        // snap) before the count-in fixes the visuals there — otherwise the
        // count-in would start from loopA while the audio backend sits
        // elsewhere. ~50 ms tolerance, matching the loop paths.
        if (Number.isFinite(r.to) && Math.abs(r.to - target) > 0.05) {
            console.warn('[restart] seek landed at', r.to, 'but loop A is', target, '— skipping count-in');
            return false;
        }
        await startCountIn({ immediate: true });
        return true;
    }
    if (!S.isPlaying) await togglePlay();
    return true;
}
window.restartCurrentSong = restartCurrentSong;
if (window.feedBack) window.feedBack.restartCurrentSong = restartCurrentSong;

window.closeCurrentSong = closeCurrentSong;
if (window.feedBack) window.feedBack.closeCurrentSong = closeCurrentSong;

// ── Play-queue: sequential playback of a playlist / album ──────────────────
// Playing a list should advance to the next track when a song ends, instead of
// returning to the menu (the long-standing "plays one song then boots to menu"
// gap — a queue was simply never implemented). Advancing rides the SAME exit
// choke point as auto-exit and a results-card close: window.closeCurrentSong().
// Song-end paths call window.closeCurrentSong() (the auto-exit grace timer, and
// a results screen's release()), so wrapping it lets the queue advance on song
// end AND after the user dismisses a score card. A *user* exit (Escape / the ✕)
// calls the bareword closeCurrentSong(), which we deliberately leave alone, so
// leaving the player still leaves — and abandons the queue.
window.feedBack.playQueue = (function () {
    let list = [], idx = -1, source = '', arrangements = null;
    // Set true by _play() right before it drives playSong, consumed once by
    // playSong's clear-guard. The primary "don't clear the queue I'm driving"
    // signal is options.fromQueue, but a chain of plugin playSong wrappers
    // (nam_tone, midi_amp, fretboard, invert_highway, tabview, ...) forward only
    // (filename, arrangement) and silently drop the options object — so the flag
    // never arrived and the queue cleared itself the instant its first song
    // started (a gig/album/playlist never advanced). This flag rides beside the
    // wrapper chain, not through it.
    let _internalPlay = false;
    const active = () => idx >= 0 && idx < list.length;
    const hasNext = () => active() && idx < list.length - 1;
    function clear() { list = []; idx = -1; source = ''; arrangements = null; }
    function _play(i) {
        const fn = list[i];
        // fromQueue is the in-band signal; _internalPlay is the out-of-band one
        // that survives wrapper chains dropping the options arg. Both set; either
        // suffices. playSong runs its clear-guard synchronously at entry, and the
        // wrapper chain reaches it synchronously, so the flag is still set then.
        _internalPlay = true;
        window.playSong(encodeURIComponent(fn), arrangements ? arrangements[i] : undefined, { fromQueue: true });
    }
    function start(files, opts) {
        files = (files || []).filter(Boolean);
        if (!files.length) return false;
        list = files.slice(); idx = 0;
        source = (opts && opts.source) || '';
        arrangements = (opts && opts.arrangements) ? opts.arrangements.slice() : null;
        if (opts && opts.shuffle && list.length > 1) {
            // Fisher-Yates, once at start. Swap arrangements in lockstep so an
            // album slot's pinned arrangement stays glued to its file (#685).
            for (let i = list.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [list[i], list[j]] = [list[j], list[i]];
                if (arrangements) [arrangements[i], arrangements[j]] = [arrangements[j], arrangements[i]];
            }
        }
        if (window.fbNotify) {
            try { window.fbNotify.show({ title: 'Playing ' + (source || 'queue'), message: files.length + ' songs', icon: '▶' }); } catch (e) { /* */ }
        }
        _play(idx);
        return true;
    }
    function advance() {
        if (!hasNext()) { clear(); return false; }
        idx++;
        _play(idx);
        return true;
    }
    return {
        start: start, advance: advance, hasNext: hasNext, active: active, clear: clear,
        // True when the current song is a queue ADVANCE (song 2..N of a set),
        // false for its first song or a standalone play. The venue uses this to
        // fly in once on arrival at the set, then continue the room between
        // songs instead of replaying the arrival flyover every track.
        isContinuation: function () { return active() && idx > 0; },
        // One-shot: true iff _play just kicked off this playSong. Consumed on
        // read so a later MANUAL play still clears the queue. playSong calls this
        // instead of trusting options.fromQueue to survive the wrapper chain.
        _consumeInternalPlay: function () { const v = _internalPlay; _internalPlay = false; return v; },
        source: function () { return source; },
        remaining: function () { return active() ? list.length - idx - 1 : 0; },
        // What's coming, for consumers that RENDER the queue (a results
        // screen's "Up next: … starting in 10s" strip) without reaching into
        // queue internals. Null when nothing follows.
        peekNext: function () {
            return hasNext()
                ? { filename: list[idx + 1], index: idx + 1, total: list.length }
                : null;
        },
    };
})();

// Make the song-end exit queue-aware (see above). Wrap window.closeCurrentSong
// (and feedBack.closeCurrentSong) so that when a queue has a next track, we play
// it instead of returning to the menu. The bareword closeCurrentSong() used by a
// user-initiated exit is unaffected.
(function () {
    const realClose = window.closeCurrentSong;
    function queueAwareClose() {
        const q = window.feedBack.playQueue;
        if (q && q.hasNext()) { q.advance(); return; }
        if (q) q.clear();
        return realClose.apply(this, arguments);
    }
    window.closeCurrentSong = queueAwareClose;
    if (window.feedBack) window.feedBack.closeCurrentSong = queueAwareClose;
})();

// Settings checkbox setter (onchange="setConfirmExitSong(this.checked)").
window.setConfirmExitSong = function (on) {
    try { localStorage.setItem('confirmExitSong', on ? '1' : '0'); } catch (_) { /* private mode */ }
    const el = document.getElementById('setting-confirm-exit');
    if (el && el.checked !== !!on) el.checked = !!on;
};

let _exitConfirmOpen = false;   // guard against stacking confirm modals

// User-initiated request to leave the player. Honors the confirm toggle; the
// actual exit is always closeCurrentSong() (origin-aware teardown).
function requestExitSong() {
    if (!_exitConfirmEnabled()) { closeCurrentSong(); return; }
    if (_exitConfirmOpen) return;   // already asking
    _openExitConfirm();
}
window.requestExitSong = requestExitSong;
if (window.feedBack) window.feedBack.requestExitSong = requestExitSong;

// A *true* modal (role="dialog" aria-modal="true" + .feedBack-modal) so the
// Escape/Space carve-outs classify it as a focus trap — they won't fire
// player-back / play-pause while it's up. Opening it PAUSES the song so it
// isn't running (or being scored) behind the prompt; Stay resumes exactly what
// we paused. Escape matches every other modal (and the generic _confirmDialog):
// it *dismisses* the prompt → Stay → drops you back into the (resumed) song —
// so a second Escape does NOT leave. Leaving is the explicit, default-focused
// "Leave" button, so Space/Enter (or click) is the keyboard "just get me out".
function _openExitConfirm() {
    _exitConfirmOpen = true;
    // Freeze the song while the user decides: cancel any pending count-in (so it
    // can't start playback behind the modal) and pause if we're playing. Stay
    // resumes only what we paused (wasPlaying), and only if the same song is
    // still live on the player — guarding a teardown/seek/end behind the prompt.
    _cancelCountIn();
    const _resumeGen = audioSeekGen();
    const _wasPlaying = S.isPlaying;
    if (_wasPlaying) Promise.resolve(togglePlay()).catch(() => {});
    const overlay = document.createElement('div');
    overlay.id = 'fb-exit-confirm';
    overlay.className = 'feedBack-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Leave this song?');
    overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:200', 'display:flex',
        'align-items:center', 'justify-content:center',
        'background:rgba(0,0,0,0.6)',
        'font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
    ].join(';');

    const card = document.createElement('div');
    card.style.cssText = [
        'max-width:min(92vw,360px)', 'padding:18px 18px 14px',
        'background:#111827', 'color:#e5e7eb',
        'border:1px solid rgba(148,163,184,0.25)', 'border-radius:12px',
        'box-shadow:0 12px 40px rgba(0,0,0,0.5)', 'text-align:left',
    ].join(';');
    const h = document.createElement('div');
    h.textContent = 'Leave this song?';
    h.style.cssText = 'font-size:16px;font-weight:700;color:#fff;margin-bottom:6px';
    const p = document.createElement('div');
    p.textContent = 'You can pick up where you left off from the Resume pill.';
    p.style.cssText = 'opacity:0.75;margin-bottom:16px';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
    const stayBtn = document.createElement('button');
    stayBtn.type = 'button';
    stayBtn.textContent = 'Stay';
    stayBtn.style.cssText = 'padding:8px 14px;border:1px solid rgba(148,163,184,0.3);border-radius:8px;background:transparent;color:#e5e7eb;cursor:pointer';
    const leaveBtn = document.createElement('button');
    leaveBtn.type = 'button';
    leaveBtn.textContent = 'Leave';
    leaveBtn.style.cssText = 'padding:8px 14px;border:0;border-radius:8px;background:#4080e0;color:#fff;font-weight:600;cursor:pointer';

    let settled = false;
    function close(leave) {
        if (settled) return;
        settled = true;
        _exitConfirmOpen = false;
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        if (leave) { closeCurrentSong(); return; }
        // Stay → resume exactly what we paused, but only if the session is still
        // the same live song on the player (not torn down / ended / seeked away
        // behind the modal). If the user was already paused, leave them paused.
        if (_wasPlaying && !S.isPlaying &&
            audioSeekGen() === _resumeGen &&
            document.querySelector('.screen.active')?.id === 'player') {
            Promise.resolve(togglePlay()).catch(() => {});
        }
    }
    // Capture-phase so this dialog owns Escape and it can't fall through to the
    // player-scope back shortcut. Escape = Stay (dismiss the prompt and resume
    // the song) — consistent with every other modal, so a second Escape does
    // NOT leave. Space/Enter stay on native activation of the focused button
    // (Leave by default), so the keyboard "leave" is Space/Enter.
    function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(false); }
    }
    document.addEventListener('keydown', onKey, true);
    leaveBtn.addEventListener('click', () => close(true));
    stayBtn.addEventListener('click', () => close(false));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(false); });

    row.appendChild(stayBtn);
    row.appendChild(leaveBtn);
    card.appendChild(h);
    card.appendChild(p);
    card.appendChild(row);
    overlay.appendChild(card);
    (document.body || document.documentElement).appendChild(overlay);
    // Trap Tab within the dialog (Stay ↔ Leave) so focus can't fall back to the
    // player controls underneath while it's open.
    _trapFocusInModal(overlay);
    // Default focus on "Leave" so Space/Enter leaves immediately.
    leaveBtn.focus();
}
window._openExitConfirm = _openExitConfirm;   // exposed for tests/debugging




window.applySpeedPreset = applySpeedPreset;



if (window.feedBack) {
    window.feedBack.on('song:loaded', syncDefaultArrangementPin);
    window.feedBack.on('arrangement:changed', syncDefaultArrangementPin);
    // feedBack's event bus dispatches CustomEvent with the payload in
    // event.detail (see EventTarget setup around line 699), so the
    // handler receives an Event, not the raw payload.
    window.feedBack.on('song:ready', (e) => {
        _applyMasteryAvailability(!!e.detail?.hasPhraseData);
        // Auto mode: re-evaluate the active renderer against the
        // newly-loaded song. The picker's current <option> value is the
        // source of truth here — localStorage is a persistence mirror
        // that can throw in private / sandboxed contexts, and the
        // picker already reflects fresh-install / post-cleanup
        // fallthroughs to 'auto' even when writes failed.
        const sel = document.getElementById('viz-picker');
        if (sel && sel.value === 'auto') {
            _autoMatchViz();
        } else if (sel) {
            // Explicit selection: the renderer persists across songs, so a
            // notation-only arrangement landing on a non-notation viz (e.g.
            // the fresh-install highway_3d default) would render an empty
            // board with no explanation. Surface the install hint.
            _maybeShowNotationViewHint(sel.value);
        }
    });
}










// ── Highway → Editor handoff ("Edit region") ────────────────────────────
// The flip side of the editor's "Loop in 3D" button: jump from the player
// to the Song Editor scrolled to the region you're looking at, edit, then
// (via the editor's Loop-in-3D) come straight back. Reuses the existing
// A/B loop as the region, falling back to the section under the playhead.

// Resolve the region to edit: the active A/B loop if set, else the section
// containing the playhead, else a short window around it. All in seconds.
function _resolveEditRegion() {
    if (loopA !== null && loopB !== null) return { a: loopA, b: loopB };
    const t = _audioTime();
    try {
        const secs = (window.highway && typeof window.highway.getSections === 'function')
            ? window.highway.getSections() : [];
        if (Array.isArray(secs) && secs.length) {
            let start = null, end = null;
            for (let i = 0; i < secs.length; i++) {
                const st = _sectionPracticeStartTime(secs[i]);
                if (!Number.isFinite(st)) continue;
                if (st <= t + 1e-6) {
                    start = st;
                    const nx = secs[i + 1] ? _sectionPracticeStartTime(secs[i + 1]) : NaN;
                    end = Number.isFinite(nx) ? nx : null;
                } else if (start !== null) {
                    break;
                }
            }
            if (start !== null) return { a: start, b: (end !== null && end > start) ? end : start + 8 };
        }
    } catch (_) { /* fall through to the window default */ }
    return { a: Math.max(0, t - 4), b: t + 4 };
}

/* @pure:editor-pending-view:start */
function _buildEditorPendingViewPure(filename, arrangement, region, opts) {
    const options = opts || {};
    const view = {
        filename,
        arrangement: Number.isFinite(arrangement) && arrangement >= 0 ? arrangement : 0,
        barSel: region ? { startTime: region.a, endTime: region.b } : null,
    };
    if (options.returnToHighway) view.returnToHighway = true;
    if (typeof options.cursorTime === 'number') {
        view.cursorTime = options.cursorTime;
    } else if (region && typeof region.a === 'number') {
        view.cursorTime = region.a;
    }
    if (typeof options.scrollX === 'number') view.scrollX = Math.max(0, options.scrollX);
    if (typeof options.zoom === 'number' && options.zoom > 0) view.zoom = options.zoom;
    return view;
}
/* @pure:editor-pending-view:end */

// Enable "Edit region" whenever the editor plugin is present and a song is
// loaded; show "↩ Editor" only while a return context is pending.
function _updateEditRegionBtn() {
    const hasEditor = typeof window.editSong === 'function';
    const editBtn = document.getElementById('btn-edit-region');
    if (editBtn) {
        editBtn.classList.toggle('hidden', !hasEditor);
        editBtn.disabled = !currentFilename;
    }
    const retBtn = document.getElementById('btn-return-editor');
    if (retBtn) {
        retBtn.classList.toggle('hidden', !(hasEditor && window._highwayReturnCtx));
    }
}

// Open the Song Editor at the current region.
function editRegionInEditor() {
    if (typeof window.editSong !== 'function' || !currentFilename) return;
    const region = _resolveEditRegion();
    let arrangement = 0;
    try {
        const si = window.highway && typeof window.highway.getSongInfo === 'function' ? window.highway.getSongInfo() : null;
        if (si && typeof si.arrangement_index === 'number' && si.arrangement_index >= 0) {
            arrangement = si.arrangement_index;
        }
    } catch (_) { /* default to 0 */ }
    window._editorPendingView = _buildEditorPendingViewPure(currentFilename, arrangement, region, {
        returnToHighway: true,
    });
    window.editSong(currentFilename);
}
window.editRegionInEditor = editRegionInEditor;

// Return from the editor to the highway loop we came from (set by the
// song:ready applier above). The editor consumes _editorPendingView to
// restore the exact edit position; here we just navigate back.
function returnToEditorFromHighway() {
    const ctx = window._highwayReturnCtx;
    if (!ctx || typeof window.editSong !== 'function') return;
    window._highwayReturnCtx = null;
    const region = ctx.barSel
        ? { a: ctx.barSel.startTime, b: ctx.barSel.endTime }
        : null;
    window._editorPendingView = _buildEditorPendingViewPure(ctx.filename, ctx.arrangement, region, {
        scrollX: ctx.scrollX,
        zoom: ctx.zoom,
        cursorTime: ctx.cursorTime,
    });
    window.editSong(ctx.filename);
}
window.returnToEditorFromHighway = returnToEditorFromHighway;























































window.onSectionParentClick = onSectionParentClick;
window.onSectionPracticeWholeChange = onSectionPracticeWholeChange;
window.onPhrasePrev = onPhrasePrev;
window.onPhraseNext = onPhraseNext;



























// Time display + highway sync
// hud-time write cache: the 60 Hz tick below used to rewrite textContent
// (and getElementById) every tick even though the mm:ss display only
// changes once a second — each write invalidates layout. Write-on-change
// with a cached element ref (re-resolved if detached).
let _hudTimeEl = null;
let _hudTimeLast = '';
setInterval(() => {
    let ct = _audioTime();
    const dur = _audioDuration();
    if (dur && !isCountingIn()) {
        // JUCE end-of-track: HTML5 fires 'ended'; JUCE needs a manual check
        if (window._juceMode && S.isPlaying && ct >= dur) {
            S.isPlaying = false;
            setPlayButtonState(false);
            window.feedBack.isPlaying = false;
            window.feedBack.emit('song:ended', _songEventPayload());
            jucePlayer.pause().catch((err) => console.warn('[app] end-of-track pause error:', err));
        }
        // A-B loop: count-in then seek back to A
        else if (loopA !== null && loopB !== null && ct >= loopB) {
            S.lastAudioTime = loopB;
            startCountIn();
        }
        // Detect and fix audio time jumps (browser seeking bug; skip for JUCE — position is polled)
        else if (!window._juceMode && S.isPlaying && Math.abs(ct - S.lastAudioTime) > 30 && S.lastAudioTime > 0) {
            console.warn(`Audio time jumped from ${S.lastAudioTime.toFixed(1)} to ${ct.toFixed(1)}, resetting`);
            _audioSeek(S.lastAudioTime, 'jump-fix');
            // Treat the corrected position as canonical for the rest of this
            // tick. Otherwise we'd write the stale jumped `ct` into
            // lastAudioTime below and ping-pong on the next tick.
            ct = S.lastAudioTime;
        }
        S.lastAudioTime = ct;
        const hudText = `${formatTime(ct)} / ${formatTime(dur)}`;
        if (hudText !== _hudTimeLast) {
            if (!_hudTimeEl || !_hudTimeEl.isConnected) _hudTimeEl = document.getElementById('hud-time');
            if (_hudTimeEl) _hudTimeEl.textContent = hudText;
            _hudTimeLast = hudText;
        }
        if (dur) {
            _maybeRefreshSectionPracticeDuration(dur);
        }
    }
    _ensureSectionPracticeBar();
    if (_sectionPracticeBarIsReady() && _sectionPracticeSourceSections().length) {
        _updateSectionPracticeHighlight(ct);
    }
    if (!isCountingIn()) window.highway.setTime(ct);
}, 1000 / 60);

_installSectionPracticeDrawHook();

// ── Centralized Keyboard Shortcut Registry ───────────────────────────────
//
// Plugins can register keyboard shortcuts via window.registerShortcut().
// Shortcuts are scope-aware (global, player, library, plugin-specific) and
// support optional condition callbacks for dynamic enable/disable.
//
// Panel-scoped shortcuts:
//   - Each panel has its own shortcut registry
//   - Use window.createShortcutPanel(id) to create a panel
//   - Use window.setActiveShortcutPanel(id) to set the active panel
//   - Shortcuts are registered to the active panel
//   - This allows multiple panels (e.g., splitscreen) to have their own shortcuts
//
// API:
//   window.registerShortcut({
//     key: string,              // Required: key value (e.key) or key code (e.code)
//     description: string,     // Required: shown in help panel
//     scope: 'global' | 'player' | 'library' | 'settings' | 'plugin-{id}',  // Default: 'global'
//     condition: () => boolean,  // Optional: dynamic enable/disable guard
//     handler: (e) => void,    // Required: callback when shortcut triggers
//     modifiers: {              // Optional: require modifier keys
//       ctrl?: boolean,
//       alt?: boolean,
//       shift?: boolean,
//       meta?: boolean
//     }
//   });
//
// Panel API:
//   window.createShortcutPanel(id) - Create a new panel
//   window.setActiveShortcutPanel(id) - Set the active panel for registration
//   window.getActiveShortcutPanel() - Get the current active panel
//   window.isInShortcutPanel() - Check if running in a panel (not default)
//   window.getGlobalShortcutContext() - Get default panel for truly global shortcuts
//
// Note: The handler receives the KeyboardEvent, so you can check
// e.shiftKey, e.altKey, etc. directly in your handler if you need
// behavior that depends on modifier state (e.g., different actions
// for Shift+key vs key alone). Use the modifiers option when you
// want the shortcut to ONLY fire with specific modifiers.
//
// See CLAUDE.md for full documentation.

// ── Window ID system for per-window shortcuts ────────────────────────────────
// Each window gets a unique ID so plugins can register window-specific shortcuts.
// This is useful for popup windows (e.g., splitscreen plugin) that need their
// own keyboard shortcuts.

let _shortcutWindowId = null;

window.getShortcutWindowId = () => {
    if (_shortcutWindowId) return _shortcutWindowId;
    // Generate a unique ID for this window
    _shortcutWindowId = 'win-' + Math.random().toString(36).substr(2, 9);
    return _shortcutWindowId;
};

// ── Shortcut registry ───────────────────────────────────────────────────────

// ── Panel-scoped shortcut system ───────────────────────────────────────────
// Each panel has its own shortcut registry. This allows multiple panels
// (e.g., splitscreen) to have their own keyboard shortcuts without collisions.

// ── Panel API ───────────────────────────────────────────────────────────────

// ── Shortcut registry (routes to active panel) ───────────────────────────────

// ── Registry-based keydown handler ─────────────────────────────────────────
//
// This handler processes all registered shortcuts through the central registry.
// It runs after the library navigation handler (which handles /, ?, c, f, e, etc.)
// and before any other keydown listeners.

// ── Window cleanup ───────────────────────────────────────────────────────────
// Clean up window-specific shortcuts when a window is closed.
// This is important for popup windows (e.g., splitscreen plugin) that
// may be closed by the user.

// ── Register built-in shortcuts ───────────────────────────────────────────

registerShortcut({
    key: 'f',
    description: 'Toggle favorite',
    scope: 'library',
    handler: () => {
        // Handled by library navigation - this is for documentation only
    }
});

registerShortcut({
    key: 'e',
    description: 'Edit metadata',
    scope: 'library',
    handler: () => {
        // Handled by library navigation - this is for documentation only
    }
});

// Player shortcuts
registerShortcut({
    key: 'Space',
    description: 'Play/Pause',
    scope: 'player',
    handler: () => togglePlay()
});

registerShortcut({
    key: 'ArrowLeft',
    description: 'Seek back 5 seconds',
    scope: 'player',
    handler: () => seekBy(-5)
});

registerShortcut({
    key: 'ArrowRight',
    description: 'Seek forward 5 seconds',
    scope: 'player',
    handler: () => seekBy(5)
});

registerShortcut({
    key: 'Escape',
    description: 'Back to library',
    scope: 'player',
    handler: () => requestExitSong()
});

registerShortcut({
    key: 'Escape',
    description: 'Go back to previous screen',
    scope: 'settings',
    handler: () => showScreen(_settingsOriginScreen || 'home')
});

registerShortcut({
    key: '[',
    description: 'Offset audio back (Shift: 50ms, else 10ms)',
    scope: 'player',
    handler: (e) => nudgeAvOffsetMs(e.shiftKey ? -50 : -10)
});

registerShortcut({
    key: ']',
    description: 'Offset audio forward (Shift: 50ms, else 10ms)',
    scope: 'player',
    handler: (e) => nudgeAvOffsetMs(e.shiftKey ? 50 : 10)
});

registerShortcut({
    key: '+',
    description: 'Volume up',
    scope: 'player',
    modifiers: { ctrl: false, alt: false, meta: false },
    handler: () => _adjustSongVolume(1)
});

// Layout-portable alias — matches the physical "=/+" key (e.code === 'Equal')
// regardless of keyboard layout or shift state, so non-US layouts that
// don't map Shift+= to '+' still work.
registerShortcut({
    key: 'Equal',
    description: 'Volume up',
    scope: 'player',
    modifiers: { ctrl: false, alt: false, meta: false },
    handler: () => _adjustSongVolume(1)
});

registerShortcut({
    key: '-',
    description: 'Volume down',
    scope: 'player',
    modifiers: { ctrl: false, alt: false, meta: false },
    handler: () => _adjustSongVolume(-1)
});

registerShortcut({
    key: 'Minus',
    description: 'Volume down',
    scope: 'player',
    modifiers: { ctrl: false, alt: false, meta: false },
    handler: () => _adjustSongVolume(-1)
});

function previewEditArt(input) {
    if (!input.files || !input.files[0]) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        document.getElementById('edit-art-preview').src = e.target.result;
    };
    reader.readAsDataURL(input.files[0]);
}

async function syncLibrarySong(providerId, songId, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const { playWhenReady = false } = opts;
    if (!providerId || !songId) return;
    const currentState = _librarySyncState(providerId, songId);
    if (currentState && currentState.status === 'synced' && currentState.localFilename) {
        if (playWhenReady) playSong(encodeURIComponent(currentState.localFilename), undefined, { bridge: false });
        return currentState.result || { filename: currentState.localFilename };
    }
    if (currentState && currentState.status === 'syncing') return null;
    _setLibrarySyncState(providerId, songId, { status: 'syncing' });
    try {
        const capabilityApi = window.feedBack && window.feedBack.capabilities;
        let data = null;
        if (capabilityApi && typeof capabilityApi.command === 'function') {
            const result = await capabilityApi.command('library', 'sync-song', {
                requester: 'app.library',
                target: { providerId, songId },
                payload: opts,
            });
            if (result.outcome !== 'handled') throw new Error(result.reason || 'Library provider sync failed');
            data = result.payload && result.payload.result;
        } else {
            data = await _libraryProviderApi()?.syncSong?.(providerId, songId, opts);
        }
        if (!data) throw new Error('Library provider sync did not return a result');
        const localFilename = data.filename || data.localFilename || data.local_filename || data.playFilename || data.play_filename || '';
        const message = localFilename
            ? 'Ready to play'
            : (data.cachedPath ? 'Loaded to local cache' : 'Loaded');
        _setLibrarySyncState(providerId, songId, { status: 'synced', message, localFilename, result: data });
        L.treeStats = null;
        L.favTreeStats = null;
        L.tuningNames = null;
        L.libEpoch++;
        await loadLibrary(0);
        if (playWhenReady && localFilename) playSong(encodeURIComponent(localFilename), undefined, { bridge: false });
        return data;
    } catch (error) {
        _setLibrarySyncState(providerId, songId, { status: 'error', message: error.message || 'Unknown error' });
        console.warn('Remote library load failed:', error);
        return null;
    }
}

// Delegated click handlers
document.addEventListener('click', e => {
    // Edit button
    const edit = e.target.closest('.edit-btn');
    if (edit) {
        e.stopPropagation();
        const entry = edit.closest('[data-play]');
        openEditModal(JSON.parse(edit.dataset.edit), entry);
        return;
    }
    // Favorite button
    const fav = e.target.closest('.fav-btn');
    if (fav) {
        e.stopPropagation();
        toggleFavorite(decodeURIComponent(fav.dataset.fav));
        return;
    }
    // Retune button
    const btn = e.target.closest('.retune-btn');
    if (btn) {
        e.stopPropagation();
        retuneSong(btn.dataset.retune, decodeURIComponent(btn.dataset.title), btn.dataset.tuning, btn.dataset.target || 'E Standard');
        return;
    }
    // Remote song card / row without a local playable file yet.
    const remoteEntry = e.target.closest('[data-library-song]');
    if (remoteEntry && !remoteEntry.dataset.play && !e.target.closest('button')) {
        const providerId = decodeURIComponent(remoteEntry.dataset.libraryProvider || '');
        if (!_providerSupports(providerId, 'song.sync')) return;
        _setLibSelection(remoteEntry, { focus: false });
        syncLibrarySong(
            providerId,
            decodeURIComponent(remoteEntry.dataset.librarySong || ''),
            { playWhenReady: true },
        );
        return;
    }
    // Song card / row — keep persistent selection in sync with mouse
    // clicks so arrow-keying after a click resumes from where the
    // user clicked, not from a stale highlight.
    // Guard: if the click originated from any <button> inside the
    // entry (e.g. a plugin-provided .sloppak-convert-btn that has no
    // own stopPropagation handler above), don't treat it as a play
    // action. Known action buttons (.fav-btn, .edit-btn, .retune-btn)
    // already return early via stopPropagation() above; this catches
    // any remaining button that bubbles through.
    const card = e.target.closest('[data-play]');
    if (card && !e.target.closest('button')) {
        _setLibSelection(card, { focus: false });
        playSong(card.dataset.play, undefined, { bridge: false });
    }
});

// Load library on start. loadSettings is awaited alongside so persisted
// values (A/V offset, mastery, etc.) are applied to the highway + HUD
// before any playSong runs — otherwise a fast click could start
// playback with stale settings before /api/settings returned.
(async () => {
    // Splitscreen pop-out windows (`?ssFollower=1`) load this same app but
    // get driven into "follower mode" by the splitscreen plugin once it
    // loads — which is *after* this init runs. Without this, the library
    // (`#home`, marked `active` in index.html) renders and paints first, so
    // the popup briefly flashes the song grid before swapping to the player.
    // Switch to the player screen up front so the popup shows player chrome
    // (empty, then populated by the plugin) the whole time. The wasted
    // library fetch below is negligible next to the whole-app + every-plugin
    // re-load a popup already does.
    const isFollowerWindow = (() => {
        try { return new URLSearchParams(location.search).get('ssFollower') === '1'; }
        catch (_) { return false; }
    })();
    if (isFollowerWindow) {
        // Await it — showScreen is async, so a bare call would turn even a
        // synchronous DOM error into an unhandled rejection that this try
        // couldn't catch. Surface failures (e.g. `#player` missing/renamed)
        // instead of silently bringing the library flash back.
        try { await showScreen('player'); }
        catch (e) { console.warn('[feedBack] follower-window: showScreen("player") failed:', e); }
    }
    await loadLibraryProviders({ restoreSaved: true });
    // Restore library-filter UI state from localStorage before the first
    // grid fetch so the badge/chips are accurate immediately
    // (feedBack#129).
    _renderLibFilterChips();
    _updateLibFiltersBadge();
    // Restore the persisted sort and format-filter dropdowns BEFORE
    // the first setLibView() call — setLibView triggers loadLibrary,
    // which reads `lib-sort` / `lib-format` to build the API query
    // string. Without this, the first page would always load with
    // "Artist A-Z" / "All formats" regardless of what the user had
    // picked previously.
    const savedSort = _readPersistedChoice(_LIB_SORT_KEY, _LIB_SORT_VALUES, 'artist');
    const savedFormat = _readPersistedChoice(_LIB_FORMAT_KEY, _LIB_FORMAT_VALUES, '');
    const sortEl = document.getElementById('lib-sort');
    const fmtEl = document.getElementById('lib-format');
    if (sortEl) sortEl.value = savedSort;
    if (fmtEl) fmtEl.value = savedFormat;
    // Treat the initial page load the same as a screen entry so the
    // restored selection scrolls into view exactly once on hard
    // reload. Without this, the scroll-on-screen-entry flag only
    // ever triggered when the user navigated away and back via
    // showScreen — a hard refresh in tree mode would land on the
    // top of the tree and force the user to scroll back to find
    // their selection.
    _libScrollOnNextRender.home = true;
    // `libView` was already initialized from localStorage at module
    // load; passing it through setLibView replays the visibility
    // toggling and triggers the initial load.
    setLibView(libView);
    try { await loadSettings(); } catch (e) { console.warn('initial loadSettings failed:', e); }
    // Re-apply any saved per-string highway colors to both highways.
    try { initHighwayColors(); } catch (e) { console.warn('initHighwayColors failed:', e); }
    // App-wide restart banner — must wire once, outside loadSettings(), so a
    // download finishing while the user is on a non-Settings screen still
    // pops the banner.
    try { initAppUpdateBanner(); } catch (e) { console.warn('initAppUpdateBanner failed:', e); }
    // Seed the track fill on every themed slider so they render correctly
    // before any interaction — e.g. the speed slider (untouched by
    // loadSettings) before the first playSong, or follower windows that
    // enter the player screen via showScreen('player') without playSong.
    document.querySelectorAll('.slider-input').forEach(el => handleSliderInput(el));
    try { _wireSpeedPresetsOnce(); } catch (e) { console.warn('_wireSpeedPresetsOnce failed:', e); }
    checkScanAndLoad();

    const plugins = await bootstrapPluginsAndUi();
    await loadLibraryProviders({ restoreSaved: true, reloadOnChange: true });
    // Viz picker depends on plugin scripts having loaded (to find
    // window.feedBackViz_<id> factories), so run it after loadPlugins.
    // Reuse the plugin list loadPlugins just fetched — no need to
    // round-trip /api/plugins a second time.
    _populateVizPicker(plugins);
    // Alpha-build heads-up banner — only revealed when the running version
    // string contains "alpha" (case-insensitive). Stays hidden on stable,
    // beta, RC, or any other channel. The banner element lives in the
    // library-section markup; toggling the `hidden` Tailwind utility is the
    // entire surface area, so a test harness can sandbox this against a
    // minimal document stub.
    function _updateAlphaWarningBanner(version) {
        const banner = document.getElementById('alpha-warning-banner');
        if (!banner) return;
        const isAlpha = typeof version === 'string'
            && version.toLowerCase().includes('alpha');
        banner.classList.toggle('hidden', !isAlpha);
    }
    fetch('/api/version')
        .then(r => { if (!r.ok) throw new Error(); return r.json(); })
        .then(d => {
            const v = typeof d.version === 'string' ? d.version.trim() : '';
            if (v && v.toLowerCase() !== 'unknown') {
                const navEl = document.getElementById('app-version');
                if (navEl) navEl.textContent = 'v' + v;
                const aboutEl = document.getElementById('app-version-about');
                if (aboutEl) aboutEl.textContent = 'v' + v;
            }
            _updateAlphaWarningBanner(v);
            // Defense-in-depth: server validates the env-var-supplied URLs,
            // but the About <a href> values are configurable so the UI also
            // rejects anything that isn't http(s) with a non-empty hostname.
            // A bare regex prefix check would accept malformed values like
            // "https://" — `new URL` + protocol + hostname catches them
            // (and `hostname`, not `host`, so port-only authorities like
            // "http://:80/path" are rejected too).
            // The source and license links are checked independently so a
            // rejected source_url doesn't gate a valid license_url.
            const isSafeHref = (u) => {
                if (typeof u !== 'string' || !u) return false;
                try {
                    const parsed = new URL(u);
                    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
                    // `host` includes the port — "http://:80/path" has
                    // host ":80" but no real hostname. `hostname` is what
                    // we actually want.
                    return !!parsed.hostname;
                } catch (_) {
                    return false;
                }
            };
            if (isSafeHref(d.source_url)) {
                const srcLink = document.getElementById('about-source-link');
                if (srcLink) srcLink.href = d.source_url;
            }
            if (isSafeHref(d.license_url)) {
                const licLink = document.getElementById('about-license-link');
                if (licLink) licLink.href = d.license_url;
            }
        })
        .catch(() => {});
})();


// ─── The window contract ────────────────────────────────────────────────────
// app.js is a classic script today, so every top-level `function foo()` here is
// implicitly a property of `window`. The R3a migration turns this file into an
// ES module, where that stops being true — module scope is not global scope, and
// each of these names would silently vanish from `window`.
//
// Everything below is reached by NAME from outside this file, so each one is
// made explicit BEFORE the flip. While app.js is still classic this whole block
// is a no-op (it just re-assigns what is already there), which is exactly what
// makes it safe to land on its own.
//
// The consumers are: inline on*= handlers in static/v3/index.html; on*= handlers
// this file builds inside template literals; static/v3/*.js; the capabilities;
// bundled plugins; and — easy to forget, since they live in other repos —
// feedback-desktop and the external plugins. Constitution II names
// `window.playSong` / `window.showScreen` / `window.feedBack` as the public
// extension contract.
//
// Guarded by tests/js/window_contract.test.js. Add a name here the moment
// anything outside app.js calls it.
// ── The host seam ───────────────────────────────────────────────────────────
// Hand app.js's own functions DOWN to the carved modules.
//
// This runs at TOP LEVEL, during app.js's synchronous module evaluation, and
// deliberately sits immediately before the window contract below — because that
// contract is what makes the carved handlers (onPhraseNext, practiceSection, …)
// clickable. Wiring the seam inside the async boot function instead would leave a
// real window: app.js's body finishes, the handlers go live on `window`, and a user
// clicking one before the awaits resolve would hit
// `[host] … was read before configureHost() ran`. Synchronous, and ordered ahead of
// the handlers, closes that.
//
// ./js/host.js THROWS on an unwired hook rather than quietly returning undefined, and
// tests/js/host_contract.test.js fails CI if this list and the host.* uses under
// static/js/ ever drift apart.
configureHost({
    // shortcuts.js's library arrow-nav needs syncLibrarySong (Enter on a selected row). It
    // cannot import it: syncLibrarySong reaches showScreen/playSong, and a module importing
    // app.js closes a cycle. So it comes across the seam, and host.js throws loudly if this line
    // is ever dropped.
    syncLibrarySong,
    handleSliderInput,
    playSong,
    // count-in is a module now, so section-practice reaches it through the seam too —
    // these are simply count-in's own exports, handed across.
    startCountIn,
    _cancelCountIn,
    _updateEditRegionBtn,
    // section-practice reaches the loop module through the seam, not by importing it:
    // loops imports section-practice (clearLoop drops its selection), so the reverse
    // edge has to be indirection or the graph cycles. These are simply the loop
    // module's own exports, handed across.
    setLoop,
    clearLoop,
    // Read-only getters. The module only ever READS these reassigned scalars, so no
    // state container is needed. loopA/loopB/_loopMutationGen are owned by
    // ./js/loops.js now and imported here as live bindings; currentFilename is still
    // app.js's.
    loopA: () => loopA,
    loopB: () => loopB,
    _loopMutationGen: () => _loopMutationGen,
    currentFilename: () => currentFilename,
});

// `esc` is here for out-of-tree plugins only: their screen.js loads as a classic
// script and called esc() back when app.js was one too and it was an implicit
// global. Nothing in core reads window.esc — import it from ./js/dom.js instead.
Object.assign(window, {
    _confirmDialog, _getArrangementNamingMode, _libraryLocalFilename, _librarySongArtUrl,
    _librarySongId, _onHeaderClick, _onNamingModeChange, _trapFocusInModal,
    changeArrangement, checkPluginUpdates, clearLibFilters, clearLoop,
    deleteSelectedLoop, esc, exportDiagnostics, exportSettings, filterFavorites,
    filterLibrary, fullRescanLibrary, goFavPage, handleSliderInput,
    hideScanBanner, importSettings, loadPlugins, loadSavedLoop,
    loadSettings, onSectionPracticeModeChange, openEditModal, persistSetting,
    pickDlcFolder, pinCurrentArrangementDefault, playSong, previewDiagnostics,
    previewEditArt, renderGridCards, renderTreeInto, rescanLibrary,
    retuneSong, saveCurrentLoop, saveSettings, seekBy,
    setAvOffsetMs, setFavView, setInstrumentPathway, setLibView,
    setLibraryProvider, setLoopEnd, setLoopStart, setMastery,
    setSpeed, setViz, showScreen, sortFavorites,
    sortLibrary, syncLibrarySong, toggleAllArtists, toggleAllFavoriteArtists,
    toggleLibFilters, togglePlay, toggleSectionPracticePopover, uiPrompt,
    updatePlugin, uploadSongs,

    // These four are invisible to every static scan. app.js:2156-2157 picks the
    // handler NAME at runtime —
    //     const letterFn = favoritesOnly ? 'filterFavTreeLetter' : 'filterTreeLetter';
    // — and interpolates it: `onclick="${letterFn}('A')"`. So the names never
    // appear as identifiers anywhere, and ESLint / no-undef / a grep for
    // `onclick="fn` all miss them. They are the library A-Z rail and its
    // pagination; drop one and those buttons throw at click time, nowhere else.
    filterFavTreeLetter, filterTreeLetter, goFavTreePage, goTreePage,
});
