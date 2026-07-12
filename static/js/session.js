//
// ━━━ THIS WAS THE UNCUTTABLE HEART, AND IT IS 359 LINES ━━━
//
// At the start of the app.js carve, seeding a dependency closure from count-in, from loops, from
// section-practice or from the JUCE seek shim all returned the SAME 178-function, 3,360-line
// set. playSong and showScreen called each other; everything called them; nothing could be cut
// anywhere. The conclusion — correct at the time — was that no closure-based carve could touch
// it at any seed, and the answer was a HOST SEAM.
//
// That was true THEN. It is not true now. Every slice taken out since (transport, loops,
// count-in, section-practice, the library, the edit modal, settings) removed edges, and the
// strongly-connected component DISSOLVED. This closure is 36 declarations with an interface
// width of FOUR.
//
// The lesson is not that the seam was wrong. The seam is what MADE this possible: it let the
// carves proceed against a cyclic core instead of stalling on it. The lesson is to RE-MEASURE.
// An SCC is a fact about a graph at a moment, not a property of the code.
//
// ━━━ THE GATE STATEMENTS AT THE BOTTOM, AND WHY NO SCAN FOUND THEM ━━━
//
// window.feedBack.holdAutoplay / holdAutoExit and their two event handlers are TOP-LEVEL
// STATEMENTS, not declarations. They WRITE this module's state (_autoplayHeld, _autoExitTimer,
// …), and an imported binding is READ-ONLY — so left behind in app.js, every one of them threw
// "Assignment to constant variable" the instant this module existed.
//
// A dependency scan that walks DECLARATIONS cannot see them. Only the browser A/B did. It is the
// same blind spot that nearly shipped a dead library A-Z rail (#896): app.js keeps its public
// API in top-level statements, and those are invisible to a call-graph.
//
// ━━━ ZERO OUTSIDE WRITES, BY MOVING THE BOUNDARY RATHER THAN BUILDING MACHINERY ━━━
//
// Autoplay scalars and the wake-lock state were written from outside — which would have forced a
// setter or a container. But the writers (_releaseAutoplay, _acquireWakeLock) plainly belong
// here. Pulling them in left ZERO outside writes, so every export is a plain import. Same move as
// settings (#920): measure the writers before you reach for a container.

import {
    loadSettings,
} from './settings.js';
import {
    clearLoop,
    loadSavedLoops,
} from './loops.js';
import {
    audio,
} from './audio-el.js';
import {
    _snapshotResumeSession,
} from './resume-session.js';
import {
    _resetJuceAudioShimChain,
} from './juce-audio.js';
import {
    _hideSectionPracticeBar,
    _resetSectionPracticeLog,
    _scheduleSectionPracticeRetries,
} from './section-practice.js';
import {
    _cancelCountIn,
    armCreditsHideOnPlay,
    hideSongCreditsOverlay,
    holdCreditsThen,
    scheduleCreditsHide,
    showSongCreditsOverlay,
    startSongCountIn,
} from './count-in.js';
import {
    _autoplayExitEnabled,
    _countdownBeforeSongEnabled,
    _resetPlaybackSpeedForNewSong,
} from './player-controls.js';
import {
    _audioTime,
    _resetAudioSeekState,
    _songEventPayload,
    jucePlayer,
    setPlayButtonState,
    togglePlay,
} from './transport.js';
import {
    _activeLibraryProviderId,
    _bumpLibNavGeneration,
    _getArrangementNamingMode,
    _libScrollOnNextRender,
    _resetLibraryProviderViewState,
    loadFavorites,
    loadLibrary,
    loadLibraryProviders,
    stopInfiniteScroll,
} from './library.js';
import {
    S,
} from './player-state.js';
import {
    L,
} from './library-state.js';
// Tracks which list screen launched the player so Esc-from-player
// returns the user to that screen instead of always defaulting to
// the Library (feedBack#126). Reset on every `playSong` call so a
// song launched from a deep-link / plugin screen still gets a sane
// fallback ('home').
export let _playerOriginScreen = 'home';

export let _settingsOriginScreen = 'home';

// ── Screen Navigation ─────────────────────────────────────────────────────
export async function showScreen(id) {
    // ── 'home' is the LEGACY library screen. Always route it to the v3 Songs list. ──
    //
    // The v3 shell replaced #home with #v3-songs. That mapping DID exist — but only inside
    // wrappers on `window.showScreen`, and only for callers that go through `window`:
    //
    //     app.js publishes the raw fn  ->  shell.js wraps it (adding the mapping)
    //                                  ->  the stems plugin wraps it AGAIN, capturing whatever
    //                                      happened to be there at the time
    //
    // Two ways that fails, and testers hit both:
    //
    //   1. ORDER. Three independent parties monkey-patch window.showScreen, each capturing the
    //      current value. Plugins load ASYNCHRONOUSLY, so the chain links up in whatever order
    //      the race settles — and any capture taken before shell.js installs, or any
    //      re-assignment after it, silently drops the mapping.
    //
    //   2. THE INTERNAL CALLERS NEVER TOUCHED window.showScreen AT ALL. closeCurrentSong and the
    //      Esc-from-settings shortcut call the IMPORTED showScreen directly, so no wrapper ever
    //      sees them. Verified in a browser: the unwrapped function with 'home' lands on the dead
    //      legacy screen every single time.
    //
    // Hence "randomly, when moving to the library from another menu option" — and "never when a
    // song ends", because closeCurrentSong resolves its target through _resolvePlayerOrigin(),
    // which already applies this mapping.
    //
    // So it lives HERE now: ONE guard in the function every caller routes through, rather than a
    // chain of monkey-patches that must each remember.
    //
    // ONLY 'home'. NOT 'v3-home'. _resolvePlayerOrigin() maps BOTH — correctly, because it
    // computes where to RETURN TO after a song, and coming back to the Songs list from the
    // dashboard is the right behaviour. Copying that condition here was a [P1] (Codex caught it):
    // #v3-home is the v3 DASHBOARD, a real screen the shell's Home nav, the onboarding tour and
    // the dashboard re-render listener all target. Redirecting it would make Home unreachable.
    //
    // A legacy alias is not the same thing as a return target.
    if (id === 'home' && document.getElementById('v3-songs')) {
        id = 'v3-songs';
    }

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

export let currentFilename = '';

export function _playbackApi() {
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
export const _bridgeRecordLast = new Map();

export const _BRIDGE_RECORD_MIN_MS = 5000;

export function _recordPlaybackBridge(bridgeId, legacySurface, reason) {
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

// Screen Wake Lock — keep the display awake while a song is playing so the
// OS screensaver doesn't kick in during windowed-mode playback (only audio +
// the highway animation are active, so the input-idle timer otherwise fires).
// Engaged only while playing (acquire on play/resume, release on
// pause/ended/stop) per issue #686. In a plain browser this uses the W3C
// Screen Wake Lock API; inside feedBack-desktop (Electron) navigator.wakeLock
// is unreliable, so we also drive the native powerSaveBlocker bridge when it
// is exposed — both calls are best-effort and degrade silently elsewhere.
export let _screenWakeLock = null;

export let _wakeLockPending = false;

// Desired state: true while a song should be keeping the screen awake. This is
// the source of truth that survives the async gap of navigator.wakeLock.request
// — set synchronously by acquire/release so an in-flight request that resolves
// after playback already stopped can release itself instead of leaking a lock.
export let _wakeLockWanted = false;

// Set when an acquire is requested while one is already in flight (e.g. a quick
// hide→show during the first request); the in-flight request retries once on
// settle so a transient NotAllowedError doesn't leave the song unprotected.
export let _wakeLockRetry = false;

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
export let _desktopAwakeReq = false;

// Monotonic id of the most recent bridge call, so a stale (out-of-order)
// rejection from a superseded call can be ignored rather than corrupting the
// marker — a boolean alone can't tell "my request failed" from "an older
// same-valued request failed after a newer one already succeeded".
export let _desktopAwakeGen = 0;

// Drive the native feedBack-desktop blocker to exactly (wanted && visible),
// mirroring the browser wake lock which is only held while the page is visible.
// Gating on visibility stops a minimized Electron window from keeping the whole
// display awake. No-op in a plain browser; isolated from the wakeLock path so a
// flaky bridge can't abort it.
export function _syncDesktopBridge() {
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

export async function _acquireWakeLock() {
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

export async function _releaseWakeLock() {
    _wakeLockWanted = false;
    _syncDesktopBridge();
    if (!_screenWakeLock) return;
    try { await _screenWakeLock.release(); } catch (e) { /* already released */ }
    _screenWakeLock = null;
}

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
export function _resolvePlayerOrigin() {
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
export let _pendingAutostart = false;

// Autoplay gate (window.feedBack.holdAutoplay): a plugin (the tuner) can defer the
// auto-start of a freshly-loaded song until it's cleared — "tune before you play".
// The hold is claimed synchronously on song:loading (so it beats this song:ready
// autostart); release() — or a fail-open backstop — runs the deferred start.
// Generation-guarded so a newer song invalidates a stale hold. Manual Play never
// flows through here, so Play always wins.
export let _autoplayHeld = false;

export let _autoplayStart = null;

export let _autoplayGen = 0;

export let _autoplayBackstop = null;

export const AUTOPLAY_HOLD_BACKSTOP_MS = 12000;

export function _clearAutoplayHold() {
    if (_autoplayBackstop) { clearTimeout(_autoplayBackstop); _autoplayBackstop = null; }
    _autoplayHeld = false;
    _autoplayStart = null;
    _autoplayGen++;
}

export function _releaseAutoplay(gen) {
    if (gen !== _autoplayGen) return;            // a newer song superseded this hold
    if (_autoplayBackstop) { clearTimeout(_autoplayBackstop); _autoplayBackstop = null; }
    _autoplayHeld = false;
    const start = _autoplayStart;
    _autoplayStart = null;
    if (typeof start === 'function') start();
}

export let _autoplayHoldToken = 0;

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

// Auto-exit: when the song ends, return to the launching menu. A scoring
// plugin that shows an end-of-song results screen calls holdAutoExit() to
// defer this; the user closing that screen (its Close button calls
// window.closeCurrentSong()) performs the exit. With no results screen the
// grace timer returns to the menu on its own.
export const AUTO_EXIT_GRACE_MS = 1500;

export let _autoExitTimer = null;

export let _autoExitHeld = false;

// Bumped every time the auto-exit state is reset (new song via playSong, and
// each song:ended). A hold's release() captures the generation at hold time
// and no-ops once it changes, so a plugin that drops or fires its release
// handle after the player has moved on can never navigate a fresh session —
// callers don't need to balance the handle.
export let _autoExitGen = 0;

export function _clearAutoExit() {
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
export function _resultsOverlayVisible() {
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
export let artAbortController = null;

export async function playSong(filename, arrangement, options) {
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

// Leave the player and return to the screen the song was launched from
// (Esc shortcut uses the same origin-aware target). showScreen() owns the
// full teardown: song:stop, audio unload, window.highway.stop(), count-in cancel.
export function closeCurrentSong() {
    // A real close (user Escape/✕, or the queue-aware wrapper once the queue is
    // exhausted) abandons any play-queue so a stale one can't advance later.
    if (window.feedBack && window.feedBack.playQueue) window.feedBack.playQueue.clear();
    return showScreen(_playerOriginScreen || 'home');
}
