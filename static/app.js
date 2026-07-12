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
// The playback transport. These used to BE app.js — they are imported back now, and the
// four modules that reached for them through the host seam import them directly instead.
import {
    setPlayButtonState, jucePlayer, _audioTime, _audioDuration, _songEventPayload,
    _markPlaybackPaused, _markPlaybackResumed, _emitPlaybackStopped, _emitSongPositionChanged,
    _waitForSongReady, _resetAudioSeekState, _audioSeek, togglePlay, seekBy, audioSeekGen,
} from './js/transport.js';


// Demo analytics — real impl set by demo.js; no-op in normal builds
window.feedBackDemoTrack = window.feedBackDemoTrack ?? null;

// ── Global keyboard shortcuts ─────────────────────────────────────────────
//
// `/` focuses the active screen's search input (Library / Favorites);
// `Esc` while focused blurs and clears it. Mirrors the GitHub / Gmail
// convention. The listener bails when the user is already typing in
// any text-accepting element so it can't intercept normal typing —
// including inputs inside the filters drawer, plugin settings, or
// modal dialogs.
function _isTextInput(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT') {
        // Some <input> types (button, checkbox, radio, range, ...) don't
        // accept text; only intercept the ones that do.
        const t = (el.type || 'text').toLowerCase();
        return ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(t);
    }
    if (tag === 'TEXTAREA') return true;
    if (tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
}

function _isShortcutHelpKey(e) {
    return e.key === '?' || (e.shiftKey && (e.code === 'Slash' || e.key === '/'));
}

function _isShortcutHelpSuppressedTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT') {
        const t = (el.type || 'text').toLowerCase();
        return ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(t);
    }
    if (tag === 'TEXTAREA') return true;
    if (el.isContentEditable) return true;
    if (el.closest && el.closest('#lib-filter-drawer, [role="dialog"], #edit-modal, .feedBack-modal')) return true;
    return false;
}

function _activeSearchInput() {
    // Pick the search field for whichever screen is currently active.
    // No match (e.g. on the player or settings screen) means `/` does
    // nothing — the shortcut only fires where a search box exists.
    const active = document.querySelector('.screen.active');
    if (!active) return null;
    if (active.id === 'home') return document.getElementById('lib-filter');
    if (active.id === 'favorites') return document.getElementById('fav-filter');
    return null;
}

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


function _gridColumns(container) {
    // Count columns by grouping the first row of children by their
    // top coordinate. Robust against any grid-template-columns syntax
    // (`repeat(...)`, `auto-fit`, named lines, etc.) where naively
    // splitting `getComputedStyle().gridTemplateColumns` on whitespace
    // would miscount because of spaces inside `repeat(...)` /
    // `minmax(...)`. Falls back to 1 when the container is empty
    // so callers' max(1, ...) clamps stay valid.
    if (!container) return 1;
    const children = Array.from(container.children).filter(
        c => c && c.offsetParent !== null
    );
    if (!children.length) return 1;
    const firstTop = children[0].getBoundingClientRect().top;
    let cols = 0;
    for (const c of children) {
        // Allow ~1px slop for sub-pixel rounding so two children that
        // would visually align still group together.
        if (Math.abs(c.getBoundingClientRect().top - firstTop) < 1.5) cols++;
        else break;
    }
    return Math.max(1, cols);
}

// Tracks which list screen launched the player so Esc-from-player
// returns the user to that screen instead of always defaulting to
// the Library (feedBack#126). Reset on every `playSong` call so a
// song launched from a deep-link / plugin screen still gets a sane
// fallback ('home').
let _playerOriginScreen = 'home';
let _settingsOriginScreen = 'home';

function _isInsideInteractiveControl(el) {
    // Bail when the user is interacting with anything that has its
    // own keyboard semantics — form controls (checkbox / select /
    // button) consume arrow keys for their own behavior, and the
    // filters drawer is a focus trap of those. Without this guard the
    // library's arrow nav would steal arrow presses from a focused
    // tuning checkbox or sort dropdown.
    if (!el) return false;
    const tag = el.tagName;
    if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(tag)) return true;
    if (el.isContentEditable) return true;
    if (el.closest && el.closest('#lib-filter-drawer, [role="dialog"], #edit-modal')) return true;
    return false;
}


function _isSpaceKey(e) {
    return e.key === ' ' || e.key === 'Spacebar';
}


function _shortcutDispatchBlocked(e) {
    if (_isTextInput(e.target)) return true;
    // Space in Section Practice bar should pause/resume, not toggle checkboxes/buttons.
    if (_isSpaceKey(e) && _sectionPracticeBarContains(e.target)) return false;
    // While the Section Practice popover is open, Esc just closes it (handled by
    // the popover's own keydown listener) — suppress the player-scope
    // "back to library" Esc so the user doesn't get bounced out of the player.
    if (e.key === 'Escape' && _sectionPracticePopoverOpen()) return true;
    // Space on the player screen should always play/pause, even if focus is on a
    // sidebar nav link, player rail button, popover control, or any other
    // interactive element — the shortcut dispatcher calls preventDefault so the
    // focused element won't also activate. Two exceptions keep native Space:
    // text inputs (already exempted above), and focus inside a true modal
    // dialog (role="dialog" aria-modal="true", or a .feedBack-modal overlay)
    // layered over the player — a modal traps interaction, so Space must reach
    // its focused control (e.g. the Close button) rather than toggle playback
    // behind it. Non-modal player popovers/toasts (loop A/B, arrangement pin,
    // role="dialog" aria-modal="false") are not modals and stay covered.
    if (_isSpaceKey(e) && _getCurrentContext().isPlayer &&
        !(e.target && e.target.closest &&
          e.target.closest('[role="dialog"][aria-modal="true"], .feedBack-modal'))) {
        return false;
    }
    // Escape is the universal "back" action and must fire like Space above even
    // when a transport/rail control <button> holds keyboard focus after a click
    // — otherwise a focused control swallows Esc and the user can't leave the
    // song until they click empty canvas (feedBack — "Escape in song not
    // consistent"). It applies on the player (exit the song) AND settings
    // (return to the previous screen), both of which register an Escape=Back
    // shortcut. The earlier guards still win: text inputs are exempted at the
    // top (Esc there clears/blurs the field), and the Section Practice popover
    // already claimed Esc above. A true modal layered over the screen still
    // traps Esc — the modal-overlay check keeps Esc closing the modal rather
    // than ejecting past it to the screen behind.
    if (e.key === 'Escape') {
        const ctx = _getCurrentContext();
        if ((ctx.isPlayer || ctx.isSettings) &&
            !(e.target && e.target.closest &&
              e.target.closest('[role="dialog"][aria-modal="true"], .feedBack-modal'))) {
            return false;
        }
    }
    return _isInsideInteractiveControl(e.target);
}

function _handleLibArrowNav(e) {
    // Space (' ') is the standard activation key for focusable
    // elements alongside Enter — without it, a screen-reader user
    // hitting Space on a focused card would just scroll the page
    // instead of activating it. We treat Space identically to Enter
    // inside this handler.
    const isActivate = e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar';
    if (!isActivate &&
        !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
        return false;
    }
    if (_isInsideInteractiveControl(document.activeElement)) return false;
    const { items, container, mode } = _libNavItems();
    if (!items.length) return false;

    const currentTarget = (document.activeElement && items.includes(document.activeElement))
        ? document.activeElement
        : (_lastLibSelected && items.includes(_lastLibSelected) ? _lastLibSelected : null);

    if (isActivate) {
        if (!currentTarget) return false;
        e.preventDefault();
        // Sync persistent selection before activating so Tab-then-Enter
        // (no prior arrow nav or mouse click) still lights up the `.selected`
        // ring and updates `_lastLibSelected`/localStorage — consistent with
        // the click delegate at the bottom of this file.
        _setLibSelection(currentTarget, { focus: false });
        if (currentTarget.classList.contains('song-row') ||
            currentTarget.classList.contains('song-card')) {
            if (currentTarget.dataset.librarySong && !currentTarget.dataset.play) {
                const providerId = decodeURIComponent(currentTarget.dataset.libraryProvider || '');
                if (!_providerSupports(providerId, 'song.sync')) return true;
                syncLibrarySong(
                    providerId,
                    decodeURIComponent(currentTarget.dataset.librarySong || ''),
                    { playWhenReady: true },
                );
                return true;
            }
            // Song row OR card → play it. Pass `dataset.play` raw to
            // match the click delegate; `playSong` handles decoding
            // internally so decoding here would double-decode and
            // throw `URIError` on filenames containing `%`.
            playSong(currentTarget.dataset.play, undefined, { bridge: false });
        } else if (currentTarget.classList.contains('artist-header') ||
                   currentTarget.classList.contains('album-header')) {
            // Header row → toggle the parent open/closed and re-derive
            // visible items so the next arrow press lands correctly.
            // `_toggleHeader` keeps `aria-expanded` in sync for
            // assistive tech.
            _toggleHeader(currentTarget);
            // Keep keyboard focus on the header we just toggled —
            // browsers sometimes drop focus to body when the
            // surrounding subtree changes display.
            currentTarget.focus({ preventScroll: true });
        }
        return true;
    }

    if (e.key === 'Home') { e.preventDefault(); _setLibSelection(items[0]); return true; }
    if (e.key === 'End')  { e.preventDefault(); _setLibSelection(items[items.length - 1]); return true; }

    if (mode === 'list') {
        if (e.key === 'ArrowDown') { e.preventDefault(); _moveSelectionInItems(items, 1); return true; }
        if (e.key === 'ArrowUp')   { e.preventDefault(); _moveSelectionInItems(items, -1); return true; }
        // Right/Left expand and collapse the artist/album under focus,
        // file-manager style. With nothing selected yet, both keys
        // initialize selection on the first visible item (matches
        // Up/Down behavior in `_moveSelectionInItems`) so the first
        // press doesn't fall through to native scroll.
        if (!currentTarget && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
            e.preventDefault();
            _setLibSelection(items[0]);
            return true;
        }
        if (e.key === 'ArrowRight' && currentTarget) {
            const parent = (currentTarget.classList.contains('artist-header') ||
                            currentTarget.classList.contains('album-header'))
                ? currentTarget.parentElement : null;
            if (parent && !parent.classList.contains('open')) {
                e.preventDefault();
                // Use the shared toggle path so aria-expanded stays
                // synced with the visual state for screen readers.
                _toggleHeader(currentTarget);
                currentTarget.focus({ preventScroll: true });
                return true;
            }
            // Already open — step to the next visible item (which is
            // the first child of this header).
            e.preventDefault();
            _moveSelectionInItems(items, 1);
            return true;
        }
        if (e.key === 'ArrowLeft' && currentTarget) {
            // If on an open header, collapse it. If on a song row or
            // closed header, jump to the nearest enclosing header.
            const isHeader = currentTarget.classList.contains('artist-header') ||
                             currentTarget.classList.contains('album-header');
            const headerParent = isHeader ? currentTarget.parentElement : null;
            if (headerParent && headerParent.classList.contains('open')) {
                e.preventDefault();
                _toggleHeader(currentTarget);
                currentTarget.focus({ preventScroll: true });
                return true;
            }
            // Walk up to the nearest .album-header / .artist-header
            // ancestor's sibling header. Closest album-group → its
            // header; otherwise closest artist-row → its header.
            const albumGroup = currentTarget.closest('.album-group');
            if (albumGroup && albumGroup.contains(currentTarget) &&
                !currentTarget.classList.contains('album-header')) {
                e.preventDefault();
                _setLibSelection(albumGroup.querySelector('.album-header'));
                return true;
            }
            const artistRow = currentTarget.closest('.artist-row');
            if (artistRow && !currentTarget.classList.contains('artist-header')) {
                e.preventDefault();
                _setLibSelection(artistRow.querySelector('.artist-header'));
                return true;
            }
            return false;
        }
        return false;
    }
    // Grid mode: 2D nav. Columns are read from the live CSS grid so
    // we follow the responsive breakpoints automatically.
    const cols = _gridColumns(container);
    if (e.key === 'ArrowRight') { e.preventDefault(); _moveSelectionInItems(items, 1); return true; }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); _moveSelectionInItems(items, -1); return true; }
    if (e.key === 'ArrowDown')  { e.preventDefault(); _moveSelectionInItems(items, cols); return true; }
    if (e.key === 'ArrowUp')    { e.preventDefault(); _moveSelectionInItems(items, -cols); return true; }
    return false;
}



// Shortcut cheat-sheet overlay. Opens on `?` (Shift+/), closes on
// Esc (handled by the generic modal close path) or on backdrop /
// close-button click. The list mirrors the canonical shortcut table
// in this file's keydown handler — when a shortcut changes here, the
// table below should change too. We keep it inline rather than
// fetching a separate file so the cheat sheet can never disagree
// with the version of app.js the user actually loaded.
function _openShortcutsModal() {
    if (document.getElementById('shortcuts-modal')) return;

    function _isTreeMode() {
        // Check if we're in tree view (not grid) on the active library screen
        const screen = document.querySelector('.screen.active');
        if (!screen) return false;
        const tree = screen.querySelector('#lib-tree,#fav-tree');
        return tree && !tree.classList.contains('hidden');
    }

    const ctx = _getCurrentContext();

    // Library shortcuts that are handled by the navigation system (not in registry)
    const navShortcuts = [
        { keys: '↑ ↓', desc: 'Move selection' },
        { keys: '→', desc: 'Step in', condition: _isTreeMode },
        { keys: '←', desc: 'Step out', condition: _isTreeMode },
        { keys: 'Home / End', desc: 'Jump to first / last item' },
        { keys: 'Enter / Space', desc: 'Activate selection (play song / toggle header)' },
    ];

    // Filter out items whose condition returns false
    const filterNavItems = (items) => items.filter(item => !item.condition || item.condition());

    // Format a shortcut entry for display, including modifier prefixes
    const formatShortcut = (s) => {
        const mods = s.modifiers || {};
        let label = '';
        if (mods.ctrl) label += 'Ctrl+';
        if (mods.alt) label += 'Alt+';
        if (mods.shift) label += 'Shift+';
        if (mods.meta) label += 'Meta+';
        return label + s.key;
    };

    // Get shortcuts from active panel by scope
    const getPanelShortcuts = (panel, scope) => {
        const shortcuts = [];
        for (const [key, s] of panel.shortcuts) {
            if (s.scope === scope) {
                shortcuts.push({ keys: formatShortcut(s), desc: s.description });
            }
        }
        return shortcuts;
    };

    const activePanel = _panels.get(_activePanel);
    const defaultPanel = _panels.get('default');

    // Merge shortcuts from both active and default panel for display
    const mergeShortcuts = (scope) => {
        const result = [];
        if (activePanel) result.push(...getPanelShortcuts(activePanel, scope));
        if (defaultPanel && defaultPanel !== activePanel) result.push(...getPanelShortcuts(defaultPanel, scope));
        return result;
    };

    const playerShortcuts = mergeShortcuts('player');
    const globalShortcuts = mergeShortcuts('global');
    const libraryShortcuts = mergeShortcuts('library');

    // Get plugin shortcuts for current plugin screen
    const pluginShortcuts = [];
    if (ctx.isPlugin && activePanel) {
        for (const [key, s] of activePanel.shortcuts) {
            if (s.scope.startsWith('plugin-') && s.scope === ctx.screen) {
                pluginShortcuts.push({ keys: formatShortcut(s), desc: s.description });
            }
        }
    }

    // Get shortcuts from other panels (if multiple panels exist)
    const otherPanelShortcuts = [];
    if (_panels.size > 1) {
        for (const [panelId, panel] of _panels) {
            if (panelId === _activePanel) continue;
            for (const [key, s] of panel.shortcuts) {
                otherPanelShortcuts.push({ keys: formatShortcut(s), desc: s.description, panel: panelId });
            }
        }
    }

    // Build sections based on current context
    const sections = [];
    if (ctx.isSettings) {
        sections.push({ heading: 'Settings', items: mergeShortcuts('settings') });
    } else if (ctx.isLibrary) {
        sections.push({ heading: 'Library', items: [
            ...filterNavItems(navShortcuts),
            ...libraryShortcuts,
            { keys: 'Esc', desc: 'Clear search' }
        ]});
    }
    if (ctx.isPlayer) {
        sections.push({ heading: 'Player', items: playerShortcuts });
    }
    if (!ctx.isSettings && globalShortcuts.length > 0) {
        sections.push({ heading: 'Global', items: globalShortcuts });
    }
    if (pluginShortcuts.length > 0) {
        sections.push({ heading: 'Current Plugin', items: pluginShortcuts });
    }
    if (otherPanelShortcuts.length > 0) {
        // Group other panel shortcuts by panel
        const byPanel = new Map();
        for (const item of otherPanelShortcuts) {
            if (!byPanel.has(item.panel)) {
                byPanel.set(item.panel, []);
            }
            byPanel.get(item.panel).push(item);
        }
        for (const [panelId, items] of byPanel) {
            sections.push({ heading: `Panel ${panelId}`, items });
        }
    }

    const modal = document.createElement('div');
    modal.id = 'shortcuts-modal';
    modal.className = 'feedBack-modal fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Keyboard shortcuts');
    // Record the element that triggered the modal so Esc / close can
    // return focus to the correct entry even if _lastLibSelected drifts.
    // Scope to the active screen so a stale _lastLibSelected from a
    // different screen (e.g. Library vs Favorites) doesn't receive focus.
    const _scModal = document.querySelector('.screen.active');
    modal._opener = (_lastLibSelected && document.body.contains(_lastLibSelected)
        && _scModal && _scModal.contains(_lastLibSelected))
        ? _lastLibSelected : null;

    const sectionsHtml = sections.map(section => {
        const itemsHtml = section.items.map(({ keys, desc }) => `
            <div class="flex items-baseline justify-between gap-4 py-1.5">
                <span class="text-sm text-gray-300">${esc(desc)}</span>
                <kbd class="text-xs font-mono px-2 py-0.5 rounded bg-dark-600 border border-gray-700 text-gray-200 whitespace-nowrap">${esc(keys)}</kbd>
            </div>
        `).join('');
        return `
            <section class="mb-4 last:mb-0">
                <h4 class="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">${esc(section.heading)}</h4>
                ${itemsHtml}
            </section>
        `;
    }).join('');

    modal.innerHTML = `
        <div class="bg-dark-700 border border-gray-700 rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl">
            <div class="flex items-center justify-between mb-4">
                <h3 class="text-lg font-bold text-white">Keyboard shortcuts</h3>
                <button type="button" data-shortcuts-close
                        class="text-gray-500 hover:text-white transition flex items-center gap-1.5" aria-label="Close shortcuts">
                    <span class="text-xs text-gray-600">Esc</span>
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                </button>
            </div>
            ${sectionsHtml}
        </div>
    `;

    // Click outside the inner panel (i.e. on the backdrop) closes the
    // modal — matches the conventional dialog UX.
    modal.addEventListener('click', (ev) => {
        if (ev.target === modal || ev.target.closest('[data-shortcuts-close]')) {
            const opener = modal._opener;
            modal.remove();
            const focusTarget = (opener && document.body.contains(opener)) ? opener
                : (_lastLibSelected && document.body.contains(_lastLibSelected) ? _lastLibSelected : null);
            if (focusTarget) focusTarget.focus({ preventScroll: true });
        }
    });

    document.body.appendChild(modal);
    // Move focus into the dialog so background shortcuts (and arrow
    // nav) can't fire on the underlying library entry while the
    // overlay is open. Close button is the safe default — there's no
    // primary input to focus on a read-only cheat sheet.
    const closeBtn = modal.querySelector('[data-shortcuts-close]');
    if (closeBtn) closeBtn.focus({ preventScroll: true });
    // Trap Tab / Shift+Tab inside the modal so focus can't escape to
    // the library content underneath while the overlay is open.
    _trapFocusInModal(modal);
}

document.addEventListener('keydown', (e) => {
    // Modifier-key combos belong to the browser / OS shortcuts; never
    // intercept those.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (_handleLibArrowNav(e)) return;

    // `?` (Shift+/) opens the keyboard-shortcuts cheat sheet. Some
    // Linux/Electron stacks report Shift+/ as key='/' with code='Slash',
    // so check the help shape before treating plain '/' as search.
    if (_isShortcutHelpKey(e)) {
        if (_isShortcutHelpSuppressedTarget(e.target || document.activeElement)) return;
        e.preventDefault();
        // Stop other keydown listeners on document (notably the shortcut
        // registry below) from also consuming this event — otherwise a
        // Linux/Electron Shift+Slash reported as key='/' opens help here and
        // then the registry's plain `/` library-search shortcut focuses
        // #lib-filter behind the modal. (Copilot review on #602.)
        e.stopImmediatePropagation();
        _openShortcutsModal();
        return;
    }

    if (e.key === '/') {
        if (_isTextInput(document.activeElement)) return;
        // Also bail when focus is inside the filter drawer, a dialog, or
        // any other interactive region — those contexts have their own
        // keyboard semantics and shouldn't be hijacked by the search
        // shortcut (e.g. a focused checkbox inside the filters drawer).
        if (_isInsideInteractiveControl(document.activeElement)) return;
        const search = _activeSearchInput();
        if (!search) return;
        e.preventDefault();  // suppress the literal '/' the input would receive
        search.focus();
        // Move caret to end without mutating .value — round-tripping
        // the value resets the browser's undo stack and can fire
        // unexpected input events on some engines. setSelectionRange
        // is the no-side-effects path.
        try {
            const len = search.value.length;
            search.setSelectionRange(len, len);
        } catch {
            // Some input types (search/email/tel) don't support
            // selection APIs in older browsers; the focus alone is
            // still useful, just no caret-end guarantee.
        }
        return;
    }

    // Single-letter shortcuts that act on the focused / selected
    // library entry — works on both grid cards and tree rows. Each
    // dispatches to a button class that the entry markup already
    // exposes, so plugins can keep owning the actual behavior:
    //   f → .fav-btn              (favorite heart toggle)
    //   e → .edit-btn             (edit metadata modal)
    // No-op when no entry is currently focused / selected, when the
    // entry doesn't expose the requested button, or when the button is disabled.
    // Bails on text input / drawer focus so single-letter typing in
    // inputs still works.
    const entryShortcut = { f: 'button.fav-btn', e: 'button.edit-btn' }[e.key.toLowerCase()];
    if (entryShortcut) {
        if (_isInsideInteractiveControl(document.activeElement)) return;
        const ae = document.activeElement;
        const activeScreen = document.querySelector('.screen.active');
        const isEntry = el => el && el.classList && (el.classList.contains('song-card') || el.classList.contains('song-row'));
        // Scope both candidates to the active screen so that a stale
        // _lastLibSelected from Library doesn't fire when the user is
        // on Favorites (or vice-versa), and so pressing f/e/c on a
        // hidden screen can't accidentally persist that filename into
        // the current screen's localStorage key.
        const inActiveScreen = el => activeScreen && activeScreen.contains(el);
        const target = (isEntry(ae) && inActiveScreen(ae)) ? ae
            : (isEntry(_lastLibSelected) && inActiveScreen(_lastLibSelected) ? _lastLibSelected : null);
        if (!target) return;
        const btn = target.querySelector(entryShortcut);
        if (!btn || btn.disabled) return;
        e.preventDefault();
        // Sync the persistent selection to the acted-on entry so that
        // Esc-to-close-modal returns focus to the correct element and
        // the `.selected` highlight stays consistent with the action.
        _setLibSelection(target, { focus: false });
        btn.click();
        return;
    }

    if (e.key === 'Escape') {
        // Modal-first: close the topmost open modal (edit-metadata,
        // shortcuts cheat sheet, future modals) so Esc dismisses
        // from anywhere — including when keyboard focus is inside
        // a form field within the modal. Restores focus to the
        // element that opened the modal (tracked in modal._opener)
        // so arrow nav resumes without an extra Tab; falls back to
        // _lastLibSelected when the opener is no longer in the DOM.
        const modals = document.querySelectorAll('[role="dialog"][aria-modal="true"].feedBack-modal');
        if (modals.length) {
            e.preventDefault();
            e.stopImmediatePropagation();
            const modal = modals[modals.length - 1];
            const opener = modal._opener;
            modal.remove();
            const focusTarget = (opener && document.body.contains(opener)) ? opener
                : (_lastLibSelected && document.body.contains(_lastLibSelected) ? _lastLibSelected : null);
            if (focusTarget) focusTarget.focus({ preventScroll: true });
            return;
        }
        // Esc while typing in either search box clears + blurs. Other Esc
        // semantics (drawer close, screen back) are handled elsewhere; we
        // only act when a search box is the focused element.
        const ae = document.activeElement;
        if (ae && (ae.id === 'lib-filter' || ae.id === 'fav-filter')) {
            if (ae.value) {
                ae.value = '';
                ae.dispatchEvent(new Event('input', { bubbles: true }));
            }
            ae.blur();
        }
    }
});

// ── Screen Navigation ─────────────────────────────────────────────────────
async function showScreen(id) {
    // Capture the previous screen before changing active classes
    const prevScreenId = document.querySelector('.screen.active')?.id;
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    // Mark the next render as a screen-entry so it scrolls the
    // restored selection into view exactly once. Routine renders
    // (search / sort / filter typing) won't have this flag set and
    // so won't yank the viewport. Also bump the nav-items
    // generation so the next keypress doesn't reuse a cache built
    // against a now-hidden screen's container.
    _bumpLibNavGeneration();
    if (id === 'home') {
        _libScrollOnNextRender.home = true;
        const beforeProviderId = _activeLibraryProviderId();
        await loadLibraryProviders({ restoreSaved: true });
        if (_activeLibraryProviderId() !== beforeProviderId) {
            _resetLibraryProviderViewState();
        } else {
            L.libEpoch++;
            L.currentPage = 0;
            L.treeStats = null;
            stopInfiniteScroll();
        }
        loadLibrary(0);
    }
    if (id === 'favorites') { _libScrollOnNextRender.favorites = true; loadFavorites(); }
    if (id === 'settings') {
        // Record where we came from so Esc can go back. The player screen
        // is torn down by the `id !== 'player'` branch below, so
        // re-entering it via showScreen() would land on a dead screen —
        // fall back to the player's own origin (or 'home') instead.
        if (prevScreenId && prevScreenId !== 'settings') {
            _settingsOriginScreen = prevScreenId === 'player'
                ? (_playerOriginScreen || 'home')
                : prevScreenId;
        }
        loadSettings();
    }
    if (id !== 'player') {
        const audio = document.getElementById('audio');
        const stopTime = _audioTime();
        const hadPlayableSong = !!audio.src || !!window._juceAudioUrl || S.isPlaying;
        // Snapshot where we were so leaving the player — especially by accident
        // — is recoverable instead of dumping the user back at bar 1 next time.
        // Must run BEFORE window.highway.stop()/audio unload, while getSongInfo() and
        // the position (stopTime) are still live.
        if (hadPlayableSong) _snapshotResumeSession(stopTime);
        window.highway.stop();
        // Cancel any queued seeks, in-flight shim closures, AND active
        // count-in timers before stopping playback so none of these paths
        // can mutate the torn-down session (mirrors the same triple reset
        // in playSong()).
        _cancelCountIn();
        _resetJuceAudioShimChain();
        _resetAudioSeekState();
        if (window._juceMode) {
            // HTML5 emits 'pause' via the media-element listener below;
            // JUCE doesn't, so plugins would stay stuck in "playing".
            // Snapshot the canonical payload BEFORE stop() resets _pos
            // to 0, then emit AFTER stop completes. Mirrors the HTML5
            // pause contract via _songEventPayload (audioT/chartT/perfNow).
            const payload = _songEventPayload();
            const wasPlaying = S.isPlaying;
            await jucePlayer.stop().catch(() => {});
            if (wasPlaying && window.feedBack) {
                window.feedBack.isPlaying = false;
                window.feedBack.emit('song:pause', payload);
            }
            window._juceMode = false;
            window._juceAudioUrl = null;
        }
        if (hadPlayableSong) window.feedBack.emit('song:stop', { time: stopTime || 0, screen: id });
        audio.pause();
        audio.src = '';
        window._currentSongAudio = null;
        // Reloading any song later should get a fresh JUCE routing attempt.
        window._clearJuceRerouteMemo?.();
        S.isPlaying = false;
        setPlayButtonState(false);
    }
    window.scrollTo(0, 0);
    if (window.feedBack) window.feedBack.emit('screen:changed', { id });
}

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



// ── Settings ─────────────────────────────────────────────────────────────
let _defaultArrangement = '';

const INSTRUMENT_PATHWAYS = ['songs', 'practice', 'learn', 'studio'];

function _normalizeInstrumentPathway(value) {
    return INSTRUMENT_PATHWAYS.includes(value) ? value : 'songs';
}

function _syncDefaultArrangementSelect(value) {
    const sel = document.getElementById('default-arrangement');
    if (!sel) return;
    const wanted = value || '';
    const existing = Array.from(sel.options).find(opt => opt.value === wanted);
    const dynamic = sel.querySelector('option[data-dynamic-default-arrangement]');
    if (dynamic && dynamic.value !== wanted) dynamic.remove();
    if (wanted && !existing) {
        const opt = document.createElement('option');
        opt.value = wanted;
        opt.textContent = `${wanted} (saved default)`;
        opt.dataset.dynamicDefaultArrangement = 'true';
        sel.appendChild(opt);
    }
    sel.value = wanted;
}

function _currentArrangementName() {
    const song = window.feedBack?.currentSong;
    const sel = document.getElementById('arr-select');
    if (song?.arrangements && sel) {
        const match = song.arrangements.find(a => String(a.index) === String(sel.value));
        if (match?.name) return String(match.name);
    }
    if (song?.arrangement) return String(song.arrangement);
    const selectedText = sel?.selectedOptions?.[0]?.textContent || '';
    return selectedText.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function syncDefaultArrangementPin() {
    const btn = document.getElementById('arr-default-pin');
    if (!btn) return;
    const name = _currentArrangementName();
    const isDefault = !!name && name === _defaultArrangement;
    const label = name
        ? (isDefault ? `${name} is the default arrangement` : `Make ${name} the default for new songs`)
        : 'Select an arrangement to make it the default';
    btn.textContent = isDefault ? '★' : '☆';
    btn.setAttribute('aria-pressed', isDefault ? 'true' : 'false');
    btn.setAttribute('aria-label', label);
    btn.disabled = !name;
    btn.classList.toggle('text-yellow-300', isDefault);
    btn.classList.toggle('text-gray-400', !isDefault);
    btn.title = label;
}

async function pinCurrentArrangementDefault() {
    const name = _currentArrangementName();
    if (!name || name === _defaultArrangement) {
        syncDefaultArrangementPin();
        return;
    }
    const resp = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ default_arrangement: name }),
    });
    if (!resp.ok) return;
    _defaultArrangement = name;
    _syncDefaultArrangementSelect(name);
    syncDefaultArrangementPin();
}


async function loadSettings() {
    // App Updates UI does not depend on /api/settings — run it first so a
    // failed fetch below still leaves the desktop updater wired up.
    // setupAppUpdates() is idempotent via _appUpdatesWired.
    setupAppUpdates();
    const resp = await fetch('/api/settings');
    const data = await resp.json();
    // Null-guard the form fields: on the v3 tabbed settings page the markup is
    // rendered by settings.js, so a control may be absent if that render hasn't
    // run yet (or on a follower window). The optional-chaining keeps loadSettings
    // from throwing and aborting the rest of the hydration.
    const dlcEl = document.getElementById('dlc-path');
    if (dlcEl) dlcEl.value = data.dlc_dir || '';
    _defaultArrangement = data.default_arrangement || '';
    _syncDefaultArrangementSelect(_defaultArrangement);
    const pathwayEl = document.getElementById('setting-instrument-pathway');
    if (pathwayEl) pathwayEl.value = _normalizeInstrumentPathway(data.pathway);
    const demucsEl = document.getElementById('demucs-server-url');
    if (demucsEl) demucsEl.value = data.demucs_server_url || '';
    const leftyEl = document.getElementById('setting-lefty');
    if (leftyEl) leftyEl.checked = window.highway.getLefty();
    const autoplayExitEl = document.getElementById('setting-autoplay-exit');
    if (autoplayExitEl) autoplayExitEl.checked = _autoplayExitEnabled();
    const showUpNextEl = document.getElementById('setting-show-upnext');
    if (showUpNextEl) showUpNextEl.checked = _showUpNextEnabled();
    const confirmExitEl = document.getElementById('setting-confirm-exit');
    if (confirmExitEl) confirmExitEl.checked = _exitConfirmEnabled();
    // Restore master-difficulty slider from persisted value (defaults
    // to 100 when the key is absent — no behaviour change for users
    // who've never touched the slider).
    const masteryPct = typeof data.master_difficulty === 'number'
        ? Math.max(0, Math.min(100, data.master_difficulty))
        : 100;
    // Drives both the player-popover slider (#mastery-slider) and the
    // Gameplay-tab "Note highway speed" slider (#setting-highway-speed), which
    // share the master_difficulty key. skipPersist so loading the value doesn't
    // echo it back to the server.
    _applyMastery(masteryPct, { skipPersist: true });
    // Route the loaded value through setAvOffsetMs so the highway's
    // render clock, the Settings slider, the HUD readout, and the
    // module variable all pick it up consistently. Pass skipPersist
    // so we don't echo the loaded value back to the server.
    setAvOffsetMs(Number(data.av_offset_ms) || 0, /* skipPersist */ true);
    // Arrangement naming mode is localStorage-only (client preference).
    const namingModeEl = document.getElementById('arrangement-naming-mode');
    if (namingModeEl) namingModeEl.value = _getArrangementNamingMode();
    // Gameplay-tab settings (tabbed settings page). Countdown is mirrored to
    // localStorage so the song-start path reads it synchronously without an
    // async /api/settings fetch on the play hot path. Miss penalty / fail
    // behavior are persist-only stubs (not yet consumed by scoring).
    const countdownOn = data.countdown_before_song === true;
    try { localStorage.setItem('countdownBeforeSong', countdownOn ? '1' : '0'); } catch (_) { /* private mode */ }
    const countdownEl = document.getElementById('setting-countdown-before-song');
    if (countdownEl) countdownEl.checked = countdownOn;
    // Achievements epic: mirror the opt-in flag to localStorage so the
    // onboarding card + the bundled achievements plugin can read the current
    // state app-wide (the plugin's own settings panel still owns the toggle).
    try { localStorage.setItem('achievementsEnabled', data.achievements_enabled === true ? '1' : '0'); } catch (_) { /* private mode */ }
    const missEl = document.getElementById('setting-miss-penalty');
    if (missEl) missEl.value = typeof data.miss_penalty === 'string' ? data.miss_penalty : 'none';
    const failEl = document.getElementById('setting-fail-behavior');
    if (failEl) failEl.value = typeof data.fail_behavior === 'string' ? data.fail_behavior : 'continue';
    // Native folder picker — only present when running inside feedBack-desktop.
    if (window.feedBackDesktop && typeof window.feedBackDesktop.pickDirectory === 'function') {
        document.getElementById('btn-pick-dlc')?.classList.remove('hidden');
    }
    syncDefaultArrangementPin();
    // Hydrate the highway-color settings UI (theme select + per-string pickers)
    // — the runtime apply path (initHighwayColors) doesn't render these controls.
    hwcInitSettingsUI();
}

// ── App Updates (desktop-only) ───────────────────────────────────────────
// Velopack auto-update controls, rendered as the first block of the Settings
// page. Whole block stays hidden in the plain web app; unhide + wire only
// when the feedBack-desktop bridge (window.feedBackDesktop.update) is
// present. On Linux the block renders but its controls are disabled — the
// desktop reports platform === 'linux' and short-circuits the IPC.

const APP_UPDATE_CHANNELS = ['stable', 'rc', 'beta', 'alpha'];
let _appUpdatesWired = false;

function setupAppUpdates() {
    const block = document.getElementById('app-updates-block');
    if (!block) return;
    const updateApi = window.feedBackDesktop?.update;
    // Per-method capability check: an older or partial feedBack-desktop
    // bridge may expose `update` without the full shape. Skip wiring (and
    // leave the block hidden) rather than throwing on first interaction.
    if (!updateApi
        || typeof updateApi.getStatus !== 'function'
        || typeof updateApi.setChannel !== 'function'
        || typeof updateApi.checkNow !== 'function') {
        return;
    }

    block.classList.remove('hidden');

    const channelSelect = document.getElementById('app-update-channel');
    const checkBtn = document.getElementById('app-update-check-now');
    const statusEl = document.getElementById('app-update-status');
    const linuxNote = document.getElementById('app-update-linux-note');
    if (!channelSelect || !checkBtn || !statusEl) return;

    // localStorage access can throw in storage-restricted contexts (sandbox
    // iframes, privacy modes, etc.); fall back to the default channel so the
    // panel still renders rather than aborting wiring entirely.
    let storedRaw = null;
    // Read the canonical key, falling back to the pre-rename
    // 'slopsmith-update-channel' so an existing channel preference survives.
    try { storedRaw = localStorage.getItem('feedBack-update-channel') || localStorage.getItem('slopsmith-update-channel'); } catch (_) { /* fall through */ }
    const stored = APP_UPDATE_CHANNELS.includes(storedRaw) ? storedRaw : 'stable';
    channelSelect.value = stored;

    const isLinux = window.feedBackDesktop?.platform === 'linux';

    function showLinuxFallback(message) {
        if (linuxNote) linuxNote.classList.remove('hidden');
        channelSelect.disabled = true;
        checkBtn.disabled = true;
        statusEl.textContent = message || 'Auto-update is not available on this platform.';
    }

    function fmtTimestamp(ts) {
        if (!ts) return 'never';
        try {
            const d = new Date(ts);
            return Number.isNaN(d.getTime()) ? 'never' : d.toLocaleString();
        } catch (_) { return 'never'; }
    }

    function renderStatus(extra) {
        try {
            // Wrap in Promise.resolve so a future getStatus() that returns
            // synchronously won't blow up on .then().
            void Promise.resolve(updateApi.getStatus()).then((s) => {
                if (!s) { statusEl.textContent = extra || 'Updater status unavailable.'; return; }
                if (s.status === 'unsupported' || s.platform === 'linux') {
                    showLinuxFallback('Auto-update is not available on Linux.');
                    return;
                }
                if (s.status === 'error') {
                    const errMsg = s.message ? `Update error: ${s.message}` : 'Update check failed.';
                    statusEl.textContent = extra ? `${extra} · ${errMsg}` : errMsg;
                    return;
                }
                const parts = [
                    `Version ${s.currentVersion || '?'}`,
                    `channel ${s.channel || channelSelect.value}`,
                    `last checked ${fmtTimestamp(s.lastChecked)}`,
                ];
                statusEl.textContent = extra ? `${extra} · ${parts.join(' · ')}` : parts.join(' · ');
            }).catch((e) => {
                console.warn('[updater] getStatus failed:', e);
                statusEl.textContent = extra || 'Failed to read updater status.';
            });
        } catch (e) {
            console.warn('[updater] getStatus threw:', e);
            statusEl.textContent = extra || 'Failed to read updater status.';
        }
    }

    if (isLinux) {
        showLinuxFallback('Auto-update is not available on Linux.');
        // Keep main informed of the persisted channel even on Linux so
        // cross-platform reasoning about the channel stays consistent.
        // setChannel() may return a Promise — chain .catch() so a rejected
        // promise doesn't surface as an unhandled rejection.
        try {
            void Promise.resolve(updateApi.setChannel(stored)).catch((e) => {
                console.warn('[updater] setChannel(linux) failed:', e);
            });
        } catch (e) {
            console.warn('[updater] setChannel(linux) threw:', e);
        }
        return;
    }

    // Inform main of the persisted channel on each load. setChannel() on
    // main is idempotent when the channel already matches.
    try {
        void Promise.resolve(updateApi.setChannel(stored)).catch((e) => {
            console.warn('[updater] setChannel(initial) failed:', e);
        });
    } catch (e) {
        console.warn('[updater] setChannel(initial) threw:', e);
    }

    if (!_appUpdatesWired) {
        // Wire DOM listeners once. The elements live in static index.html
        // and are not recreated, so re-wiring on every loadSettings() call
        // would just stack duplicate handlers.
        channelSelect.addEventListener('change', async () => {
            const val = channelSelect.value;
            if (!APP_UPDATE_CHANNELS.includes(val)) return;
            try { localStorage.setItem('feedBack-update-channel', val); localStorage.removeItem('slopsmith-update-channel'); } catch (_) {}
            try {
                // Await setChannel so the status line reflects what actually
                // happened — rendering "Channel set" unconditionally would
                // mislead users when the IPC rejects.
                await Promise.resolve(updateApi.setChannel(val));
                renderStatus(`Channel set to ${val}.`);
            } catch (e) {
                console.warn('[updater] setChannel failed:', e);
                renderStatus(`Failed to set channel to ${val}: ${e?.message || e}`);
            }
        });

        checkBtn.addEventListener('click', async () => {
            checkBtn.disabled = true;
            statusEl.textContent = 'Checking for updates…';
            let reEnableBtn = true;
            try {
                const result = await updateApi.checkNow();
                const status = result?.status || 'unknown';
                let msg;
                switch (status) {
                    case 'idle':
                        msg = "You're on the newest version in this channel.";
                        break;
                    case 'downloading':
                        msg = 'Update available — downloading…';
                        break;
                    case 'downloaded':
                        msg = 'Update downloaded — restart to apply.';
                        break;
                    case 'unsupported':
                        reEnableBtn = false;
                        showLinuxFallback('Auto-update is not available on Linux.');
                        return;
                    case 'error':
                        msg = `Update check failed${result?.message ? `: ${result.message}` : '.'}`;
                        break;
                    default:
                        msg = `Update check returned: ${status}`;
                }
                renderStatus(msg);
            } catch (e) {
                console.warn('[updater] checkNow failed:', e);
                statusEl.textContent = `Update check failed: ${e?.message || e}`;
            } finally {
                if (reEnableBtn) checkBtn.disabled = false;
            }
        });

        _appUpdatesWired = true;
    }

    renderStatus();
}

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

// Updates the fill on slider elements. Expects a CSS variable --range-pct used
// in the track fill styling. Declared as a function (not a const) so it is
// hoisted onto window — audio-mixer.js calls it as window.handleSliderInput,
// matching the window.playSong / window.showScreen cross-script convention.
function handleSliderInput(el) {
    if (!el) return;
    const min = el.min || 0;
    const max = el.max || 100;
    const pct = (el.value - min) / (max - min) * 100;
    el.style.setProperty('--range-pct', pct + '%');
}

// A/V sync calibration. Positive = audio runs ahead of visuals; we
// add this to audio.currentTime when driving the highway so the
// visuals catch up. Persisted via /api/settings as av_offset_ms.
// Live-tunable from the player screen via [ / ] keys (Shift for
// ±50 ms) and from the Settings slider; both auto-save with the
// same debounced POST. loadSettings() seeds the value via
// setAvOffsetMs without saving (skipPersist=true) to avoid an
// echo-back round-trip.
let _avOffsetMs = 0;
let _avSaveDebounce = null;
function setAvOffsetMs(ms, skipPersist) {
    // Clamp to the same bounds the Settings/player-bar sliders enforce
    // (-1000..1000 ms). Defends against bad values from /api/settings
    // landing as `value` on <input type=range>.
    const n = Number(ms);
    _avOffsetMs = Math.max(-1000, Math.min(1000, Number.isFinite(n) ? n : 0));
    // Drive the highway's render-time shift. getTime() still returns
    // the audio-aligned chart time so plugins (note detection, etc.)
    // keep scoring against the real chart clock regardless of visual
    // calibration.
    if (window.highway?.setAvOffset) window.highway.setAvOffset(_avOffsetMs);
    // Sync any visible Settings slider
    const avSlider = document.getElementById('setting-av-offset');
    if (avSlider) {
        avSlider.value = _avOffsetMs;
        handleSliderInput(avSlider);
    }
    const avVal = document.getElementById('setting-av-offset-val');
    if (avVal) avVal.textContent = Math.round(_avOffsetMs);
    // Sync the inline player-bar slider (live-tunable while playing)
    const playerAvSlider = document.getElementById('player-av-offset-slider');
    if (playerAvSlider) {
        playerAvSlider.value = _avOffsetMs;
        handleSliderInput(playerAvSlider);
    }
    const playerAvLabel = document.getElementById('player-av-offset-label');
    if (playerAvLabel) {
        const rounded = Math.round(_avOffsetMs);
        playerAvLabel.textContent = `${rounded >= 0 ? '+' : ''}${rounded}ms`;
    }
    // Update the player HUD readout (hidden when offset = 0 to
    // avoid clutter; the keyboard shortcut is documented in the
    // Settings help text so it stays discoverable).
    const hud = document.getElementById('hud-avoffset');
    if (hud) {
        hud.textContent = `A/V ${_avOffsetMs >= 0 ? '+' : ''}${Math.round(_avOffsetMs)} ms`;
        hud.classList.toggle('hidden', _avOffsetMs === 0);
    }
    if (!skipPersist) _persistAvOffset();
}
function _persistAvOffset() {
    // Debounced persist — POST only the one field; the server merges.
    if (_avSaveDebounce) clearTimeout(_avSaveDebounce);
    _avSaveDebounce = setTimeout(async () => {
        _avSaveDebounce = null;
        try {
            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ av_offset_ms: _avOffsetMs }),
            });
        } catch (e) {
            console.warn('A/V offset save failed:', e);
        }
    }, 400);
}
function nudgeAvOffsetMs(delta) {
    setAvOffsetMs(Math.max(-1000, Math.min(1000, _avOffsetMs + delta)));
}

// Open a native OS folder picker via the Electron bridge (desktop only) and
// stash the chosen path into the DLC input. User still has to hit Save.
async function pickDlcFolder() {
    if (!window.feedBackDesktop?.pickDirectory) return;
    const path = await window.feedBackDesktop.pickDirectory();
    if (path) document.getElementById('dlc-path').value = path;
}

async function saveSettings() {
    const defaultArrangement = document.getElementById('default-arrangement').value;
    const resp = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            dlc_dir: document.getElementById('dlc-path').value.trim(),
            default_arrangement: defaultArrangement,
            demucs_server_url: document.getElementById('demucs-server-url').value.trim(),
            av_offset_ms: _avOffsetMs,
        }),
    });
    const data = await resp.json();
    if (resp.ok) {
        _defaultArrangement = defaultArrangement;
        _syncDefaultArrangementSelect(_defaultArrangement);
        syncDefaultArrangementPin();
    }
    document.getElementById('settings-status').textContent = data.message || data.error;
}

document.getElementById('arr-select')?.addEventListener('change', syncDefaultArrangementPin);

// Persist a single settings field the instant a control changes (used by
// the Settings dropdowns). The /api/settings POST handler merges only the
// keys present in the body, so this one-field write won't clobber dlc_dir
// or any other setting. No debounce: a <select> change event fires once
// per selection, unlike the A/V / mastery sliders' per-pixel oninput.
//
// The Settings-dropdown autosaves run through one chain so their POSTs are
// sent one at a time, in the order the user made the changes — the last
// selection is always the last write, for both rapid changes to one
// dropdown and back-to-back changes across different dropdowns. The A/V
// and mastery slider autosaves POST directly (not through this chain);
// the server-side config.json lock is what keeps those from racing the
// dropdown writes (see save_settings() in server.py).
let _settingSaveChain = Promise.resolve();
function persistSetting(key, value) {
    const next = _settingSaveChain.then(() => _postSetting(key, value));
    // Swallow failures so one failed write doesn't poison the chain and
    // block every later save.
    _settingSaveChain = next.catch(() => {});
    return next;
}
function setInstrumentPathway(value) {
    const pathway = _normalizeInstrumentPathway(value);
    const el = document.getElementById('setting-instrument-pathway');
    if (el) el.value = pathway;
    persistSetting('pathway', pathway).then(() => {
        if (window.v3Badges && typeof window.v3Badges.reload === 'function') {
            try { window.v3Badges.reload(); } catch (_) { /* noop */ }
        }
    });
}


async function _postSetting(key, value) {
    const status = document.getElementById('settings-status');
    try {
        const resp = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [key]: value }),
        });
        const data = await resp.json();
        if (status) status.textContent = data.message || data.error || '';
    } catch (e) {
        if (status) status.textContent = 'Save failed: ' + e.message;
    }
}



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




let currentFilename = '';

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

function _playbackApi() {
    return window.feedBack && window.feedBack.playback && window.feedBack.playback.version === 1
        ? window.feedBack.playback
        : null;
}

// Bridge hits are a "this legacy surface is still in use" signal, not a call
// counter — but recordBridgeHit is not cheap (compat-shim bookkeeping, a
// playback:bridge-hit event, and a diagnostics snapshot rebuild per call).
// Plugins legitimately poll read surfaces like window.feedBack.getLoop() from
// HUD ticks (note_detect polled at ~30 Hz), which turned every tick into a
// snapshot serialization on the main thread and saturated the inspector's
// hitCount. Throttle per surface: the first call records immediately, repeats
// within the window are dropped.
const _bridgeRecordLast = new Map();
const _BRIDGE_RECORD_MIN_MS = 5000;
function _recordPlaybackBridge(bridgeId, legacySurface, reason) {
    const playback = _playbackApi();
    if (!playback || typeof playback.recordBridgeHit !== 'function') return;
    const key = `${bridgeId}|${legacySurface}`;
    const now = Date.now();
    const last = _bridgeRecordLast.get(key);
    if (last != null && now - last < _BRIDGE_RECORD_MIN_MS) return;
    _bridgeRecordLast.set(key, now);
    playback.recordBridgeHit({
        bridgeId,
        legacySurface,
        source: 'core.app',
        reason: reason || 'legacy playback surface used',
    });
}

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

// Screen Wake Lock — keep the display awake while a song is playing so the
// OS screensaver doesn't kick in during windowed-mode playback (only audio +
// the highway animation are active, so the input-idle timer otherwise fires).
// Engaged only while playing (acquire on play/resume, release on
// pause/ended/stop) per issue #686. In a plain browser this uses the W3C
// Screen Wake Lock API; inside feedBack-desktop (Electron) navigator.wakeLock
// is unreliable, so we also drive the native powerSaveBlocker bridge when it
// is exposed — both calls are best-effort and degrade silently elsewhere.
let _screenWakeLock = null;
let _wakeLockPending = false;
// Desired state: true while a song should be keeping the screen awake. This is
// the source of truth that survives the async gap of navigator.wakeLock.request
// — set synchronously by acquire/release so an in-flight request that resolves
// after playback already stopped can release itself instead of leaking a lock.
let _wakeLockWanted = false;
// Set when an acquire is requested while one is already in flight (e.g. a quick
// hide→show during the first request); the in-flight request retries once on
// settle so a transient NotAllowedError doesn't leave the song unprotected.
let _wakeLockRetry = false;
// Last value handed to the desktop bridge. This is the value we *requested*,
// not one confirmed by the IPC round trip: the Electron main-process side
// effect (powerSaveBlocker start/stop) happens when the message is received,
// before its promise resolves, so deduping on the requested value lets opposite
// transitions (true↔false) always go through promptly while still suppressing
// redundant repeats (e.g. the synchronous song:play + song:resume pair). A
// rejected/throwing call invalidates the marker (the side effect never landed)
// so the next song:* / visibilitychange retries — without an inline re-sync,
// which would tight-loop on a persistently failing bridge.
// Last value handed to the bridge: false (off) / true (on) / null (unknown —
// a call failed, so the real blocker state can't be assumed). null never equals
// a boolean `want`, so the next sync always re-sends and recovers.
let _desktopAwakeReq = false;
// Monotonic id of the most recent bridge call, so a stale (out-of-order)
// rejection from a superseded call can be ignored rather than corrupting the
// marker — a boolean alone can't tell "my request failed" from "an older
// same-valued request failed after a newer one already succeeded".
let _desktopAwakeGen = 0;
// Drive the native feedBack-desktop blocker to exactly (wanted && visible),
// mirroring the browser wake lock which is only held while the page is visible.
// Gating on visibility stops a minimized Electron window from keeping the whole
// display awake. No-op in a plain browser; isolated from the wakeLock path so a
// flaky bridge can't abort it.
function _syncDesktopBridge() {
    const want = _wakeLockWanted && document.visibilityState === 'visible';
    if (want === _desktopAwakeReq) return; // already requested this value
    const bridge = window.feedBackDesktop?.power?.setScreenAwake;
    if (typeof bridge !== 'function') return; // plain browser — nothing to sync
    _desktopAwakeReq = want;
    const gen = ++_desktopAwakeGen;
    let r;
    try {
        r = bridge(want);
    } catch (e) {
        console.debug('desktop wake bridge failed:', e?.name || e);
        if (gen === _desktopAwakeGen) _desktopAwakeReq = null; // unknown — force a re-send next event
        return;
    }
    if (r && typeof r.then === 'function') {
        r.catch((e) => {
            console.debug('desktop wake bridge rejected:', e);
            // The IPC didn't take effect; we can't assume which state the blocker
            // is in (a prior call may also have failed), so mark it unknown and
            // let the next song:* / visibilitychange re-send. Only if this is
            // still the latest request — a stale rejection from a superseded call
            // must not clobber a newer request's marker.
            if (gen === _desktopAwakeGen) _desktopAwakeReq = null;
        });
    }
}
async function _acquireWakeLock() {
    _wakeLockWanted = true;
    _syncDesktopBridge();
    if (_screenWakeLock) return; // already held — nothing to do
    // A request is already in flight (song:play and song:resume fire
    // synchronously from the audio 'play' listener, and visibilitychange can
    // re-enter): don't issue a duplicate, but remember to retry on settle so a
    // visibility bounce during the request can't strand us without a lock.
    if (_wakeLockPending) { _wakeLockRetry = true; return; }
    if (!navigator.wakeLock?.request) return;
    _wakeLockPending = true;
    _wakeLockRetry = false;
    try {
        const sentinel = await navigator.wakeLock.request('screen');
        if (!_wakeLockWanted) {
            // Playback stopped while the request was in flight — release the
            // just-granted lock immediately rather than holding it stale.
            try { await sentinel.release(); } catch (e) { /* already released */ }
            return;
        }
        _screenWakeLock = sentinel;
        sentinel.addEventListener('release', () => {
            _screenWakeLock = null;
            // The UA auto-releases on tab hide, but may also release for its own
            // reasons (power policy) while the page stays visible. Re-acquire if
            // a song is still playing and we're visible — the visibilitychange
            // handler covers the hidden→visible case.
            if (_wakeLockWanted && document.visibilityState === 'visible') {
                _acquireWakeLock();
            }
        });
    } catch (e) {
        // NotAllowedError (page hidden / no user activation) or unsupported.
        console.debug('wakeLock request failed:', e?.name || e);
    } finally {
        _wakeLockPending = false;
        // A re-acquire arrived while the request was in flight (typically a
        // hide→show bounce). If we still want the lock, are visible, and didn't
        // get one (the request raced a hidden window and rejected), try once
        // more now that the page state has settled. Bounded: only fires when a
        // bounce actually occurred, so a permanently-denied request can't loop.
        if (_wakeLockRetry && _wakeLockWanted && !_screenWakeLock
            && document.visibilityState === 'visible') {
            _wakeLockRetry = false;
            _acquireWakeLock();
        }
    }
}
async function _releaseWakeLock() {
    _wakeLockWanted = false;
    _syncDesktopBridge();
    if (!_screenWakeLock) return;
    try { await _screenWakeLock.release(); } catch (e) { /* already released */ }
    _screenWakeLock = null;
}
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
// Resolve where the player should return on Esc / close / auto-exit.
// A one-shot setReturnScreen() override wins (consumed here) — used by the
// lessons catalog so a lesson returns to the lessons screen rather than the
// library, even though the external tutorials plugin owns the playSong call.
// Otherwise remember the actual launch screen; the element-exists guard
// keeps the classic v2 UI (no #v3-* ids) from being stranded on a missing
// screen, and unknown launches fall back to 'home'. The dashboard — classic
// 'home' and the v3 shell's 'v3-home' — returns to the Songs list when it
// exists (dashboard actions call playSong() directly, so its id is the
// active screen at launch).
function _resolvePlayerOrigin() {
    const override = window.feedBack && window.feedBack._nextReturnScreen;
    if (window.feedBack) window.feedBack._nextReturnScreen = null;
    if (override && document.getElementById(override)) return override;
    const launchFrom = document.querySelector('.screen.active');
    const launchId = launchFrom && launchFrom.id;
    if (launchId && launchId !== 'player' && document.getElementById(launchId)) {
        return ((launchId === 'home' || launchId === 'v3-home') && document.getElementById('v3-songs'))
            ? 'v3-songs' : launchId;
    }
    return 'home';
}

// Autoplay: one-shot flag armed by each fresh playSong(), consumed by the
// next song:ready. song:ready also fires on arrangement switches / seeks,
// which never arm the flag, so those don't auto-restart.
let _pendingAutostart = false;
// Autoplay gate (window.feedBack.holdAutoplay): a plugin (the tuner) can defer the
// auto-start of a freshly-loaded song until it's cleared — "tune before you play".
// The hold is claimed synchronously on song:loading (so it beats this song:ready
// autostart); release() — or a fail-open backstop — runs the deferred start.
// Generation-guarded so a newer song invalidates a stale hold. Manual Play never
// flows through here, so Play always wins.
let _autoplayHeld = false;
let _autoplayStart = null;
let _autoplayGen = 0;
let _autoplayBackstop = null;
const AUTOPLAY_HOLD_BACKSTOP_MS = 12000;
function _clearAutoplayHold() {
    if (_autoplayBackstop) { clearTimeout(_autoplayBackstop); _autoplayBackstop = null; }
    _autoplayHeld = false;
    _autoplayStart = null;
    _autoplayGen++;
}
function _releaseAutoplay(gen) {
    if (gen !== _autoplayGen) return;            // a newer song superseded this hold
    if (_autoplayBackstop) { clearTimeout(_autoplayBackstop); _autoplayBackstop = null; }
    _autoplayHeld = false;
    const start = _autoplayStart;
    _autoplayStart = null;
    if (typeof start === 'function') start();
}
let _autoplayHoldToken = 0;
window.feedBack.holdAutoplay = function () {
    const gen = _autoplayGen;
    const token = ++_autoplayHoldToken;   // this hold's identity — a stale release from an earlier hold is a no-op
    _autoplayHeld = true;
    if (_autoplayBackstop) clearTimeout(_autoplayBackstop);
    // Fail-open: a hold that's never released (a plugin that claimed but wedged before
    // it could decide) must never permanently block the song. Once the holder commits
    // to an intentional, user-dismissable hold it calls release.settle() to cancel this
    // — so the backstop can't cut off e.g. a user still tuning past the timeout.
    _autoplayBackstop = setTimeout(() => _releaseAutoplay(gen), AUTOPLAY_HOLD_BACKSTOP_MS);
    let released = false;
    function release() {
        if (released || gen !== _autoplayGen || token !== _autoplayHoldToken) return;
        released = true;
        _releaseAutoplay(gen);
    }
    // Cancel the fail-open backstop WITHOUT releasing: the holder has taken explicit
    // responsibility for releasing (on dismiss), and a song switch clears the hold anyway.
    release.settle = function () {
        if (gen !== _autoplayGen || token !== _autoplayHoldToken) return;
        if (_autoplayBackstop) { clearTimeout(_autoplayBackstop); _autoplayBackstop = null; }
    };
    return release;
};
window.feedBack.on('song:ready', () => {
    if (!_pendingAutostart) return;
    _pendingAutostart = false;
    if (S.isPlaying) return;
    // Feedpak contributor credits: only real feedpak plays carry authors
    // (loose/archive and minigames get []), so a non-empty list is the gate.
    // Shown over the highway and dismissed the moment real playback begins
    // (song:play). This fresh-load path is the only place it fires —
    // arrangement switches / seeks / manual replays never arm _pendingAutostart,
    // and minigames never get here. Decoupled from autoplay below so credits
    // show on load even when autoplay-exit is disabled.
    const authors = (window.feedBack.currentSong && window.feedBack.currentSong.authors) || [];
    if (authors.length) {
        showSongCreditsOverlay(authors);
        armCreditsHideOnPlay();
    }
    // Autoplay-exit disabled: don't auto-start. Still let the credits dwell a
    // couple seconds on the freshly-loaded song, then clear them (they also
    // clear early if the user manually presses Play, via _creditsHideOnPlay).
    if (!_autoplayExitEnabled()) {
        if (authors.length) scheduleCreditsHide();
        return;
    }
    // The actual auto-start: a count-in (which handles HTML5 + _juceMode) or the
    // Play path directly. Guarded so a manual Play during a gate / credits hold
    // can't double-toggle, and so a stale (released-after-leaving) start never
    // begins playback off the player.
    const start = () => {
        if (S.isPlaying) return;
        if (!document.getElementById('player')?.classList.contains('active')) { hideSongCreditsOverlay(); return; }
        if (_countdownBeforeSongEnabled()) {
            Promise.resolve(startSongCountIn()).catch((err) => console.warn('[app] song count-in failed:', err));
        } else {
            Promise.resolve(togglePlay())
                .then(() => { if (!S.isPlaying) hideSongCreditsOverlay(); })
                .catch((err) => { console.warn('[app] autoplay failed:', err); hideSongCreditsOverlay(); });
        }
    };
    // A plugin (the tuner) may gate playback until it's cleared. The hold was
    // claimed on song:loading; stash the start and let release()/the backstop run
    // it. _cancelCountIn()/changeArrangement() clear _creditsTimer below, so a
    // teardown during the credits dwell still cancels a non-gated play.
    if (_autoplayHeld) { _autoplayStart = start; return; }
    // Not gated: a count-in starts now (it owns its on-screen dwell); otherwise
    // let the credits dwell a couple seconds first, then start.
    if (_countdownBeforeSongEnabled() || !authors.length) start();
    else holdCreditsThen(start);
});






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

// Auto-exit: when the song ends, return to the launching menu. A scoring
// plugin that shows an end-of-song results screen calls holdAutoExit() to
// defer this; the user closing that screen (its Close button calls
// window.closeCurrentSong()) performs the exit. With no results screen the
// grace timer returns to the menu on its own.
const AUTO_EXIT_GRACE_MS = 1500;
let _autoExitTimer = null;
let _autoExitHeld = false;
// Bumped every time the auto-exit state is reset (new song via playSong, and
// each song:ended). A hold's release() captures the generation at hold time
// and no-ops once it changes, so a plugin that drops or fires its release
// handle after the player has moved on can never navigate a fresh session —
// callers don't need to balance the handle.
let _autoExitGen = 0;
function _clearAutoExit() {
    if (_autoExitTimer) { clearTimeout(_autoExitTimer); _autoExitTimer = null; }
    _autoExitHeld = false;
    _autoExitGen++;
}
// Heuristic safety net for score-screen plugins that don't (yet) call
// holdAutoExit(): if a visible full-screen results/dialog overlay is on top
// when the grace timer fires, defer the auto-return and let that screen's
// own close button drive the exit (its Close should call closeCurrentSong).
// getClientRects() is used for the visibility test because it reports
// position:fixed overlays correctly, unlike offsetParent.
function _resultsOverlayVisible() {
    let nodes;
    try {
        nodes = document.querySelectorAll('[role="dialog"][aria-modal="true"], .fixed.inset-0');
    } catch (_) { return false; }
    for (const el of nodes) {
        if (!el || el.id === 'player') continue;            // never the player itself
        if (el.classList && el.classList.contains('hidden')) continue;
        if (el.getClientRects && el.getClientRects().length > 0) return true;
    }
    return false;
}
// Plugins call this synchronously from their own song:ended handler (core
// runs first, so the timer is already pending) to claim the exit.
window.feedBack.holdAutoExit = function () {
    if (_autoExitTimer) { clearTimeout(_autoExitTimer); _autoExitTimer = null; }
    _autoExitHeld = true;
    const gen = _autoExitGen;
    let released = false;
    return function release() {
        // No-op once released, or once the session has moved on (a newer
        // playSong / song:ended bumped the generation) — so a stale handle
        // never navigates away from a fresh song.
        if (released || gen !== _autoExitGen) return;
        released = true;
        if (typeof window.closeCurrentSong === 'function') window.closeCurrentSong();
    };
};
window.feedBack.on('song:ended', () => {
    _clearAutoExit();
    if (!_autoplayExitEnabled()) return;
    // Only auto-exit from the player screen (ignore stale/duplicate ends).
    const active = document.querySelector('.screen.active');
    if (!active || active.id !== 'player') return;
    _autoExitTimer = setTimeout(() => {
        _autoExitTimer = null;
        if (_autoExitHeld) return;            // a plugin explicitly claimed the exit
        if (_resultsOverlayVisible()) return; // a score/results overlay is up; let it drive the exit
        const cur = document.querySelector('.screen.active');
        if (cur && cur.id === 'player' && typeof window.closeCurrentSong === 'function') {
            window.closeCurrentSong();
        }
    }, AUTO_EXIT_GRACE_MS);
});

// Abort controller for cancelling pending requests when entering player
let artAbortController = null;

async function playSong(filename, arrangement, options) {
    console.log('playSong called:', filename);
    // A manual (non-queue) play abandons any active play-queue, so a stale queue
    // can't hijack the next song's end. The queue passes fromQueue to keep itself.
    if ((!options || !options.fromQueue) && window.feedBack && window.feedBack.playQueue) {
        window.feedBack.playQueue.clear();
    }
    if (!options || options.bridge !== false) {
        _recordPlaybackBridge('playback.window-play-song', 'window.playSong', 'legacy playSong entry point used');
    }
    // Invalidate any prior song's autoplay gate before plugins re-claim it on the
    // song:loading emit below.
    _clearAutoplayHold();
    window.feedBack.emit('song:loading', { filename, arrangement: arrangement ?? null });

    // Cancel any pending art/metadata requests
    if (artAbortController) artAbortController.abort();
    artAbortController = null;

    window.highway.stop();
    // Cancel any active count-in: clear timers/RAF and bump the gen so
    // delayed callbacks (rewind frames, post-seek then, count-in ticks,
    // post-count play) bail before mutating the new session.
    _cancelCountIn();
    // Reset the JUCE shim BEFORE awaiting jucePlayer.stop() so any in-flight
    // shim closures see a stale generation after their await and bail out
    // before mutating isPlaying / button label / song:* events for the
    // outgoing song.
    _resetJuceAudioShimChain();
    // Cancel queued _audioSeek calls from the previous song: bumping the
    // generation makes their chained callbacks bail out.
    _resetAudioSeekState();
    if (window._juceMode) {
        // Mirror the showScreen teardown: emit song:pause for the JUCE
        // path so plugins don't see a stale "playing" state on song
        // change. (HTML5 fires it via the audio element 'pause' event.)
        // Snapshot payload BEFORE stop() resets _pos so audioT/chartT
        // capture the actual paused position.
        const payload = _songEventPayload();
        const wasPlaying = S.isPlaying;
        await jucePlayer.stop().catch(() => {});
        if (wasPlaying && window.feedBack) {
            window.feedBack.isPlaying = false;
            window.feedBack.emit('song:pause', payload);
        }
        window._juceMode = false;
        window._juceAudioUrl = null;
    }
    audio.pause();
    audio.src = '';
    // Stale until the incoming song's WS handler (window.highway.js) sets it again.
    window._currentSongAudio = null;
    // Fresh JUCE routing attempt for whatever song loads next.
    window._clearJuceRerouteMemo?.();
    S.isPlaying = false;
    setPlayButtonState(false);
    _resetPlaybackSpeedForNewSong();
    clearLoop();
    _resetSectionPracticeLog();
    _hideSectionPracticeBar();
    // Reset so the jump-fix (setInterval, ~line 8979) doesn't mistake the new
    // song starting at t=0 for an unexpected seek from the previous song's
    // position. audio.currentTime may not reset synchronously when src is cleared.
    S.lastAudioTime = 0;

    currentFilename = filename;
    // A fresh load arms autoplay; a pending auto-exit from the previous
    // song is no longer relevant. A *resume* load (options.resume) instead
    // arms _pendingResume — consumed at song:ready to restore speed + seek to
    // the saved position, then start — so autostart and resume don't both try
    // to begin playback from different positions.
    if (options && options.resume && Number(options.resume.position) > 0) {
        S.pendingResume = options.resume;
        _pendingAutostart = false;
    } else {
        S.pendingResume = null;
        _pendingAutostart = true;
    }
    _clearAutoExit();
    // Remember which screen the player was launched from so Esc /
    // navigation back from the player (and auto-exit) returns the user
    // there (feedBack#126).
    _playerOriginScreen = _resolvePlayerOrigin();
    showScreen('player');

    // Wait for previous WebSocket to fully close before opening new one
    await new Promise(r => setTimeout(r, 500));
    window.highway.init(document.getElementById('highway'));

    const wsParams = new URLSearchParams();
    if (arrangement !== undefined) wsParams.set('arrangement', arrangement);
    wsParams.set('naming_mode', _getArrangementNamingMode());
    const wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/highway/${decodeURIComponent(filename)}?${wsParams.toString()}`;
    window.highway.connect(wsUrl);
    _resetSectionPracticeLog();
    _scheduleSectionPracticeRetries();
    loadSavedLoops();
    document.getElementById('quality-select').value = window.highway.getRenderScale();
    const _minScaleSel = document.getElementById('min-scale-select');
    if (_minScaleSel && window.highway.getMinRenderScale) _minScaleSel.value = String(window.highway.getMinRenderScale());
}

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

// Leave the player and return to the screen the song was launched from
// (Esc shortcut uses the same origin-aware target). showScreen() owns the
// full teardown: song:stop, audio unload, window.highway.stop(), count-in cancel.
function closeCurrentSong() {
    // A real close (user Escape/✕, or the queue-aware wrapper once the queue is
    // exhausted) abandons any play-queue so a stale one can't advance later.
    if (window.feedBack && window.feedBack.playQueue) window.feedBack.playQueue.clear();
    return showScreen(_playerOriginScreen || 'home');
}
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
    const active = () => idx >= 0 && idx < list.length;
    const hasNext = () => active() && idx < list.length - 1;
    function clear() { list = []; idx = -1; source = ''; arrangements = null; }
    function _play(i) {
        const fn = list[i];
        // fromQueue keeps the queue from clearing itself; playSong decodeURIs.
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

class ShortcutPanel {
    constructor(id) {
        this.id = id;
        this.shortcuts = new Map();
    }
    
    _compositeKey(key, scope) {
        return `${scope}::${key}`;
    }
    
    registerShortcut(options) {
        const { key, description, scope = 'global', condition = null, handler, modifiers = null } = options;
        
        if (!key || !handler) {
            console.error(`registerShortcut: key and handler are required`);
            return;
        }
        
        // Validate scope
        const validScopes = ['global', 'player', 'library', 'settings'];
        const isValidScope = validScopes.includes(scope) || 
                             scope.startsWith('plugin-');
        if (!isValidScope) {
            console.warn(`registerShortcut: invalid scope '${scope}'. Valid scopes are: global, player, library, settings, or plugin-{id}`);
        }
        
        // Conflict detection: warn if key+scope is already registered
        const compositeKey = this._compositeKey(key, scope);
        if (this.shortcuts.has(compositeKey)) {
            console.warn(`registerShortcut [${this.id}]: '${key}' in scope '${scope}' is already registered; overwriting. Previous:`, this.shortcuts.get(compositeKey));
        }
        
        this.shortcuts.set(compositeKey, { key, description, scope, condition, handler, modifiers });
    }
    
    unregisterShortcut(key, scope) {
        return this.shortcuts.delete(this._compositeKey(key, scope));
    }
    
    clearShortcuts() {
        this.shortcuts.clear();
    }
    
    listShortcuts() {
        return Array.from(this.shortcuts.entries()).map(([ck, s]) => [s.key, s]);
    }
}

// Global panel management
const _panels = new Map();
let _activePanel = null;
let _defaultPanel = null;

// Create default panel on init
const defaultPanel = new ShortcutPanel('default');
_panels.set('default', defaultPanel);
_defaultPanel = 'default';
_activePanel = 'default';

// ── Panel API ───────────────────────────────────────────────────────────────

window.createShortcutPanel = (id) => {
    if (_panels.has(id)) {
        console.warn(`createShortcutPanel: panel '${id}' already exists`);
        return _panels.get(id);
    }
    const panel = new ShortcutPanel(id);
    _panels.set(id, panel);
    return panel;
};

window.setActiveShortcutPanel = (id) => {
    if (!_panels.has(id)) {
        console.error(`setActiveShortcutPanel: panel '${id}' does not exist`);
        return;
    }
    _activePanel = id;
};

window.getActiveShortcutPanel = () => _activePanel;

window.isInShortcutPanel = () => {
    return _activePanel !== 'default';
};

window.getGlobalShortcutContext = () => {
    console.warn('getGlobalShortcutContext: Global shortcuts are exceptional. Consider using panel-scoped shortcuts instead.');
    return _panels.get('default');
};

// ── Shortcut registry (routes to active panel) ───────────────────────────────

window.registerShortcut = (options) => {
    const panelId = _activePanel || _defaultPanel || 'default';
    const panel = _panels.get(panelId);
    
    if (!panel) {
        console.error(`registerShortcut: No panel found for registration: ${panelId}`);
        return;
    }
    
    panel.registerShortcut(options);
};

// Flat, read-only snapshot of every registered shortcut across all panels,
// for the Settings → Keybinds reference tab. Dedupes by combo+scope (the same
// shortcut can live in both the active panel and the default panel) and uses
// the same modifier-prefix formatting as the shortcuts modal. Returns
// [{ combo, description, scope }]; remapping is not supported, so this is
// purely informational.
window.getAllShortcuts = () => {
    const fmt = (s) => {
        const m = s.modifiers || {};
        return (m.ctrl ? 'Ctrl+' : '') + (m.alt ? 'Alt+' : '')
            + (m.shift ? 'Shift+' : '') + (m.meta ? 'Meta+' : '') + s.key;
    };
    const seen = new Set();
    const out = [];
    for (const [, panel] of _panels) {
        if (!panel || !panel.shortcuts) continue;
        for (const [, s] of panel.shortcuts) {
            const combo = fmt(s);
            const dedupe = combo + '|' + (s.scope || '');
            if (seen.has(dedupe)) continue;
            seen.add(dedupe);
            out.push({ combo, description: s.description || '', scope: s.scope || 'global' });
        }
    }
    return out;
};

window.unregisterShortcut = (key, scope) => {
    // Try the active panel first to preserve panel isolation; fall back to
    // other panels so a shortcut registered before a panel switch is still
    // removable.
    const resolvedScope = scope || 'global';
    const activePanelId = _activePanel || _defaultPanel || 'default';
    const activePanel = _panels.get(activePanelId);
    if (activePanel && activePanel.unregisterShortcut(key, resolvedScope)) {
        return true;
    }
    for (const [panelId, panel] of _panels) {
        if (panelId === activePanelId) continue;
        if (panel.unregisterShortcut(key, resolvedScope)) {
            return true;
        }
    }
    return false;
};

window.clearWindowShortcuts = (windowId) => {
    // Remove all shortcuts registered for a specific window
    // This is for backward compatibility with window-specific shortcuts
    let removed = 0;
    for (const [panelId, panel] of _panels) {
        if (panelId.startsWith(`window-${windowId}`)) {
            panel.clearShortcuts();
            _panels.delete(panelId);
            removed++;
        }
    }
    return removed;
};

function _getCurrentContext() {
    const currentScreen = document.querySelector('.screen.active')?.id;
    return {
        screen: currentScreen,
        windowId: window.getShortcutWindowId(),
        activePanel: _activePanel,
        isPlayer: currentScreen === 'player',
        isLibrary: ['home', 'favorites'].includes(currentScreen),
        isSettings: currentScreen === 'settings',
        isPlugin: currentScreen?.startsWith('plugin-')
    };
}

function _isShortcutActive(shortcut, ctx) {
    if (shortcut.scope === 'global') return true;
    if (shortcut.scope === 'player' && ctx.isPlayer) return true;
    if (shortcut.scope === 'library' && ctx.isLibrary) return true;
    if (shortcut.scope === 'settings' && ctx.isSettings) return true;
    if (shortcut.scope.startsWith('plugin-')) {
        const pluginId = shortcut.scope.replace('plugin-', '');
        return ctx.screen === `plugin-${pluginId}`;
    }
    return false;
}

function _modifiersMatch(e, modifiers) {
    if (!modifiers) return true;
    if (modifiers.ctrl !== undefined && modifiers.ctrl !== e.ctrlKey) return false;
    if (modifiers.alt !== undefined && modifiers.alt !== e.altKey) return false;
    if (modifiers.shift !== undefined && modifiers.shift !== e.shiftKey) return false;
    if (modifiers.meta !== undefined && modifiers.meta !== e.metaKey) return false;
    return true;
}

// Debug mode for keyboard shortcuts
let _DEBUG_SHORTCUTS = false;

window._setDebugShortcuts = (enabled) => {
    _DEBUG_SHORTCUTS = enabled;
    console.log(`[Shortcuts] Debug mode ${enabled ? 'ENABLED' : 'DISABLED'}`);
};

window._listShortcuts = () => {
    console.log('=== Registered Shortcuts ===');
    for (const [panelId, panel] of _panels) {
        console.log(`Panel: ${panelId}`);
        for (const [, s] of panel.shortcuts) {
            console.log(`  ${s.key.padEnd(15)} | ${s.scope.padEnd(10)} | ${s.description}`);
        }
    }
    console.log('=== End ===');
};

window._testShortcut = (key, scope) => {
    // Mirror the dispatcher: try the active panel first, then default.
    const resolvedScope = scope || 'global';
    const tried = new Set();
    const panelOrder = [_activePanel, _defaultPanel, 'default'].filter(id => {
        if (!id || tried.has(id)) return false;
        tried.add(id);
        return true;
    });

    for (const panelId of panelOrder) {
        const panel = _panels.get(panelId);
        if (!panel) continue;
        const shortcut = panel.shortcuts.get(panel._compositeKey(key, resolvedScope));
        if (!shortcut) continue;

        const ctx = _getCurrentContext();
        const active = _isShortcutActive(shortcut, ctx);
        let conditionMet = true;
        if (shortcut.condition) {
            try { conditionMet = !!shortcut.condition(); }
            catch (err) { conditionMet = `threw: ${err.message}`; }
        }
        console.log(`Shortcut '${key}' [${resolvedScope}] [${panelId}]:`, {
            description: shortcut.description,
            scope: shortcut.scope,
            currentContext: ctx,
            isActive: active,
            conditionMet
        });
        return;
    }

    console.log(`Shortcut '${key}' (scope: ${resolvedScope}) not registered in any panel`);
};

// Expose internals for debugging (prefixed with _ to indicate private)
// These are for development/debugging only and should not be used by plugins.
window._panels = _panels;
window._getCurrentContext = _getCurrentContext;
window._isShortcutActive = _isShortcutActive;

// ── Registry-based keydown handler ─────────────────────────────────────────
//
// This handler processes all registered shortcuts through the central registry.
// It runs after the library navigation handler (which handles /, ?, c, f, e, etc.)
// and before any other keydown listeners.

document.addEventListener('keydown', e => {
    if (_shortcutDispatchBlocked(e)) return;

    const ctx = _getCurrentContext();
    const activePanel = _panels.get(_activePanel);
    const defaultPanel = _panels.get('default');
    
    if (!activePanel && !defaultPanel) return;

    if (_DEBUG_SHORTCUTS) {
        console.log('[Shortcuts] Key pressed:', { key: e.key, code: e.code, ctx, activePanel: _activePanel });
    }

    // Try active panel first, then fall back to default
    const panelsToDispatch = [];
    if (activePanel && activePanel !== defaultPanel) panelsToDispatch.push(activePanel);
    if (defaultPanel) panelsToDispatch.push(defaultPanel);

    for (const panel of panelsToDispatch) {
        for (const [, shortcut] of panel.shortcuts) {
        // Match on both e.key (character produced) and e.code (physical key)
        if (e.key !== shortcut.key && e.code !== shortcut.key) continue;

        // Check modifier keys if specified
        if (!_modifiersMatch(e, shortcut.modifiers)) continue;

        if (_DEBUG_SHORTCUTS) {
            console.log('[Shortcuts] Matched shortcut:', shortcut.key, shortcut);
        }

        // Check scope
        if (!_isShortcutActive(shortcut, ctx)) {
            if (_DEBUG_SHORTCUTS) {
                console.log('[Shortcuts] Not active - scope mismatch:', shortcut.scope, ctx);
            }
            continue;
        }

        // Check condition callback — guard against plugin errors
        if (shortcut.condition) {
            try {
                if (!shortcut.condition()) {
                    if (_DEBUG_SHORTCUTS) {
                        console.log('[Shortcuts] Not active - condition failed');
                    }
                    continue;
                }
            } catch (err) {
                console.error('[Shortcuts] condition() threw for key:', shortcut.key, err);
                continue;
            }
        }

        e.preventDefault();
        if (_DEBUG_SHORTCUTS) {
            console.log('[Shortcuts] Executing handler for:', shortcut.key);
        }
        // Guard handler against plugin errors
        try {
            shortcut.handler(e);
        } catch (err) {
            console.error('[Shortcuts] handler() threw for key:', shortcut.key, err);
        }
        return;
    }
}

    if (_DEBUG_SHORTCUTS) {
        console.log('[Shortcuts] No shortcut matched for:', e.key, e.code);
    }
});

// ── Window cleanup ───────────────────────────────────────────────────────────
// Clean up window-specific shortcuts when a window is closed.
// This is important for popup windows (e.g., splitscreen plugin) that
// may be closed by the user.

window.addEventListener('beforeunload', () => {
    const windowId = window.getShortcutWindowId();
    const removed = window.clearWindowShortcuts(windowId);
    if (removed > 0 && _DEBUG_SHORTCUTS) {
        console.log(`[Shortcuts] Cleaned up ${removed} shortcuts for window ${windowId}`);
    }
});

// ── Register built-in shortcuts ───────────────────────────────────────────

// Global shortcuts
registerShortcut({
    key: '?',
    description: 'Show keyboard shortcuts',
    scope: 'global',
    handler: () => _openShortcutsModal()
});

// Library shortcuts
registerShortcut({
    key: '/',
    description: 'Focus search',
    scope: 'library',
    handler: () => {
        const input = _activeSearchInput();
        if (input) input.focus();
    }
});

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

// ── Edit metadata modal ─────────────────────────────────────────────────
function openEditModal(songData, openerEl) {
    const artUrl = `/api/song/${encodeURIComponent(songData.f)}/art?t=${Date.now()}`;
    const modal = document.createElement('div');
    modal.id = 'edit-modal';
    modal.className = 'feedBack-modal fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm';
    // role=dialog: assistive tech announces it as a modal; also lets
    // the global keyboard listener's `_isInsideInteractiveControl`
    // bail when typing inside the modal so Library shortcuts don't
    // hijack keys from the edit form.
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Edit song metadata');
    // Record the element that triggered the modal so Esc / Cancel can
    // return focus to the exact entry the user was on, even if
    // _lastLibSelected changes before the modal closes.
    // Prefer the explicitly-passed openerEl (from the edit-btn click
    // handler, which has the exact [data-play] parent) over
    // _lastLibSelected, which may not have been updated when the
    // click's stopPropagation() prevented the card-click handler.
    const _emActive = document.querySelector('.screen.active');
    const _emLast = (_lastLibSelected && document.body.contains(_lastLibSelected)
        && _emActive && _emActive.contains(_lastLibSelected)) ? _lastLibSelected : null;
    modal._opener = (openerEl && document.body.contains(openerEl)) ? openerEl : _emLast;
    modal.innerHTML = `
        <div class="bg-dark-700 border border-gray-700 rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl">
            <h3 class="text-lg font-bold text-white mb-4">Edit Song</h3>
            <div class="space-y-3">
                <div class="flex items-center gap-4 mb-2">
                    <div class="relative group cursor-pointer" id="edit-art-wrapper">
                        <img src="${artUrl}" alt="" class="w-20 h-20 rounded-lg object-cover bg-dark-600" id="edit-art-preview">
                        <div class="absolute inset-0 bg-black/50 rounded-lg flex items-center justify-center opacity-0 group-hover:opacity-100 transition">
                            <span class="text-white text-xs">Change</span>
                        </div>
                        <input type="file" accept="image/*" id="edit-art-file" class="hidden" onchange="previewEditArt(this)">
                    </div>
                    <p class="text-xs text-gray-500 flex-1">Click image to change album art</p>
                </div>
                <div>
                    <label class="text-xs text-gray-400 mb-1 block">Title</label>
                    <input type="text" id="edit-title" value="${_escAttr(songData.t)}"
                        class="w-full bg-dark-600 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-accent/50">
                </div>
                <div>
                    <label class="text-xs text-gray-400 mb-1 block">Artist</label>
                    <input type="text" id="edit-artist" value="${_escAttr(songData.a)}"
                        class="w-full bg-dark-600 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-accent/50">
                </div>
                <div>
                    <label class="text-xs text-gray-400 mb-1 block">Album</label>
                    <input type="text" id="edit-album" value="${_escAttr(songData.al)}"
                        class="w-full bg-dark-600 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-accent/50">
                </div>
                <div>
                    <label class="text-xs text-gray-400 mb-1 block">Year</label>
                    <input type="text" inputmode="numeric" id="edit-year" value="${_escAttr(songData.y)}" placeholder="e.g. 2024"
                        class="w-full bg-dark-600 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-accent/50">
                </div>
            </div>
            <div class="flex gap-3 mt-5">
                <button data-edit-save
                    class="flex-1 bg-accent hover:bg-accent-light px-4 py-2 rounded-xl text-sm font-semibold text-white transition">Save</button>
                <button data-edit-close
                    class="px-4 py-2 bg-dark-600 hover:bg-dark-500 rounded-xl text-sm text-gray-300 transition">Cancel</button>
            </div>
            <div class="mt-4 pt-4 border-t border-gray-800">
                <button data-delete-filename="${_escAttr(songData.f)}"
                    class="w-full px-4 py-2 bg-red-900/30 hover:bg-red-900/60 border border-red-900/50 hover:border-red-700 rounded-xl text-sm text-red-300 hover:text-red-100 transition">Remove from library</button>
            </div>
        </div>`;
    document.body.appendChild(modal);

    // Move focus into the dialog's first text input so background
    // shortcuts (and arrow nav) can't fire on the underlying library
    // entry while the edit form is open. Title is the natural primary
    // field — most edits are correcting spelling there. Caret-end
    // selection so the user can keep typing rather than overtype the
    // current value.
    const titleInput = document.getElementById('edit-title');
    if (titleInput) {
        titleInput.focus({ preventScroll: true });
        try {
            const len = titleInput.value.length;
            titleInput.setSelectionRange(len, len);
        } catch { /* some browsers reject selection on certain input types */ }
    }

    // Trap Tab / Shift+Tab inside the modal so focus can't escape to
    // the library content underneath while the edit form is open.
    _trapFocusInModal(modal);

    // Click on art triggers file input
    document.getElementById('edit-art-wrapper').addEventListener('click', () => {
        document.getElementById('edit-art-file').click();
    });

    // Save — wired in JS (not an inline onclick) so the filename never has to
    // survive embedding in a single-quoted attribute string. encodeURIComponent
    // does NOT escape `'`, so a filename like `Bob's Song.sloppak` used to break
    // the inline `saveEditModal('…')` handler and silently fail the save. The
    // raw filename lives in the closure; encode it here for saveEditModal.
    const saveBtn = modal.querySelector('[data-edit-save]');
    if (saveBtn) {
        saveBtn.addEventListener('click', () => saveEditModal(encodeURIComponent(songData.f)));
    }

    const deleteBtn = modal.querySelector('[data-delete-filename]');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
            deleteSongFromModal(deleteBtn.dataset.deleteFilename);
        });
    }

    // Close on backdrop click or Cancel button; restore focus to opener.
    // Backdrop dismissal requires the gesture's mousedown to have STARTED on
    // the backdrop — not just the click/mouseup to land there. Otherwise a
    // click-drag that begins inside a field (e.g. selecting text) and is
    // released past the modal edge resolves its `click` target to the backdrop
    // and silently discards the edit. Cancel / ✕ (data-edit-close) always close.
    let _downOnBackdrop = false;
    modal.addEventListener('mousedown', (e) => { _downOnBackdrop = (e.target === modal); });
    modal.addEventListener('click', (e) => {
        if (!_editModalShouldClose(e.target, modal, _downOnBackdrop)) return;
        const opener = modal._opener;
        modal.remove();
        const focusTarget = (opener && document.body.contains(opener)) ? opener
            : (_lastLibSelected && document.body.contains(_lastLibSelected) ? _lastLibSelected : null);
        if (focusTarget) focusTarget.focus({ preventScroll: true });
    });
}

// Whether a click on the edit-metadata modal should dismiss it. The Cancel / ✕
// control (data-edit-close) always dismisses. A backdrop dismissal needs BOTH
// the click target to be the backdrop element itself AND the gesture to have
// started there (downOnBackdrop) — so a click-drag begun inside a field and
// released on the backdrop does not discard the form. Pure + top-level so it's
// unit-testable in isolation.
function _editModalShouldClose(clickTarget, modalEl, downOnBackdrop) {
    if (clickTarget && clickTarget.closest && clickTarget.closest('[data-edit-close]')) return true;
    return clickTarget === modalEl && downOnBackdrop === true;
}

function previewEditArt(input) {
    if (!input.files || !input.files[0]) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        document.getElementById('edit-art-preview').src = e.target.result;
    };
    reader.readAsDataURL(input.files[0]);
}

async function saveEditModal(encodedFilename) {
    const filename = decodeURIComponent(encodedFilename);

    // Save metadata
    await fetch(`/api/song/${encodeURIComponent(filename)}/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title: document.getElementById('edit-title').value.trim(),
            artist: document.getElementById('edit-artist').value.trim(),
            album: document.getElementById('edit-album').value.trim(),
            // Year is normalised server-side (non-numeric/empty → ""), so a
            // blank or cleared field round-trips safely.
            year: document.getElementById('edit-year').value.trim(),
        }),
    });

    // Upload art if changed
    const fileInput = document.getElementById('edit-art-file');
    if (fileInput.files && fileInput.files[0]) {
        const reader = new FileReader();
        reader.onload = async (e) => {
            await fetch(`/api/song/${encodeURIComponent(filename)}/art/upload`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: e.target.result }),
            });
        };
        reader.readAsDataURL(fileInput.files[0]);
    }

    const modal = document.getElementById('edit-modal');
    const opener = modal ? modal._opener : null;
    if (modal) modal.remove();
    // Restore focus to the entry the modal was opened from so subsequent
    // keyboard navigation resumes correctly (same as Esc / Cancel paths).
    const focusTarget = (opener && document.body.contains(opener)) ? opener
        : (_lastLibSelected && document.body.contains(_lastLibSelected) ? _lastLibSelected : null);
    if (focusTarget) focusTarget.focus({ preventScroll: true });
    // Refresh current view
    const activeScreen = document.querySelector('.screen.active');
    if (activeScreen?.id === 'favorites') loadFavorites();
    else loadLibrary();
}

async function deleteSongFromModal(filename) {
    const title = (document.getElementById('edit-title')?.value || filename).trim();
    const ok = await _confirmDialog({
        title: 'Remove from library?',
        body: `<p class="text-sm text-gray-300">Remove <span class="font-semibold text-white">${_escAttr(title)}</span> from your library?</p>
               <p class="text-xs text-red-400/90 mt-2">This permanently deletes the file from disk. This cannot be undone.</p>`,
        confirmText: 'Remove',
        cancelText: 'Cancel',
        danger: true,
    });
    if (!ok) return;
    let resp;
    try {
        resp = await fetch(`/api/song/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    } catch (e) {
        alert(`Delete failed: ${e.message}`);
        return;
    }
    if (!resp.ok) {
        let msg = resp.statusText;
        try { msg = (await resp.json()).error || msg; } catch (_) {}
        alert(`Delete failed: ${msg}`);
        return;
    }
    const modal = document.getElementById('edit-modal');
    if (modal) modal.remove();
    L.treeStats = null;
    L.favTreeStats = null;
    L.tuningNames = null;

    // Remove the deleted song's card from any currently-rendered grid/tree
    // so the user sees it disappear without waiting for a refetch. A full
    // loadLibrary() here would re-call loadGridPage(currentPage), which
    // uses 'append' mode when currentPage > 0 and re-appends the same
    // (now-shortened) page on top of what's already rendered — leaving
    // the deleted card visible. Direct DOM removal also preserves scroll
    // position, which a refetch from page 0 would lose.
    _removeLibCardsForFilename(filename);

    // Tree views group by artist with song counts; a single card removal
    // leaves stale counts, so refresh the tree for whichever screen we're
    // looking at (each tree-view renderer replaces innerHTML cleanly).
    const activeScreen = document.querySelector('.screen.active');
    if (activeScreen?.id === 'favorites') {
        // loadFavorites() routes to either loadFavGridPage (always
        // 'replace') or loadFavTreeView — both safe for a single delete.
        loadFavorites();
    } else if (libView === 'tree') {
        loadTreeView();
    }
    // Main library grid view: DOM removal above is sufficient.
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

Object.assign(window, {
    _confirmDialog, _getArrangementNamingMode, _libraryLocalFilename, _librarySongArtUrl,
    _librarySongId, _onHeaderClick, _onNamingModeChange, _trapFocusInModal,
    changeArrangement, checkPluginUpdates, clearLibFilters, clearLoop,
    deleteSelectedLoop, exportDiagnostics, exportSettings, filterFavorites,
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
