// Player controls — the speed and mastery sliders, and the four playback preference
// reads (autoplay-exit, up-next, countdown-before-song, confirm-exit).
//
// The fourth slice out of app.js's strongly-connected core, and by far the easiest:
// ONE hook and NO shared mutable state. It is here because these three groups are the
// same surface (the controls under the highway) and all three reach the same helper.
//
// The preference reads are one-line localStorage lookups that half of app.js consults
// before deciding whether to auto-start, show the Up Next pill, run a count-in, or
// confirm on exit. They travel with the controls that set them.
//
// See ./host.js: reading an unwired hook THROWS, and tests/js/host_contract.test.js
// fails CI if the hooks used here and the hooks app.js wires ever drift apart.
import { audio } from './audio-el.js';
import { host } from './host.js';

// ── Autoplay & auto-exit (global option, default ON) ──────────────────
// One toggle (`autoplayExit` in localStorage) that (a) auto-starts a song
// once it's ready and (b) returns to the launching menu when the song
// ends. Absence of the key means enabled. The behaviour lives in core
// (app.js, shared by the v3 + classic UIs); the end-of-song *score*
// screen, when present, is a plugin and hooks the contract below.
export function _autoplayExitEnabled() {
    try { return localStorage.getItem('autoplayExit') !== '0'; } catch (_) { return true; }
}

// ── "Up Next" pill (global option, default ON) ────────────────────────
// Gates the v3 player chrome's persistent upcoming-section pill
// (#v3-upnext, driven by player-chrome.js's updateUpNext). Client-only
// localStorage pref (`showUpNext`); absence of the key means enabled.
// player-chrome.js reads window.feedBack.showUpNext each tick and hides
// the pill when off.
export function _showUpNextEnabled() {
    try { return localStorage.getItem('showUpNext') !== '0'; } catch (_) { return true; }
}

// "Countdown before song" (Gameplay tab). Mirrored to localStorage by
// loadSettings so the song-start path can read it synchronously here — no
// async /api/settings fetch on the play hot path. Defaults off.
export function _countdownBeforeSongEnabled() {
    try { return localStorage.getItem('countdownBeforeSong') === '1'; } catch (_) { return false; }
}

export function _curPlaybackSpeed() {
    try {
        return window._juceMode
            ? ((window.jucePlayer && window.jucePlayer._speed) || 1)
            : (document.getElementById('audio')?.playbackRate || 1);
    } catch (_) { return 1; }
}

// ── "Ask before leaving a song" (Gameplay tab, default OFF) ────────────────
// Client-only localStorage pref (`confirmExitSong`); absence = OFF. When ON, a
// *user-initiated* exit (Escape, or the player ✕) opens a small confirm instead
// of leaving immediately. Auto-exit on song-end and a results screen's own
// Close never prompt — they call closeCurrentSong() directly, which stays the
// unguarded actual-exit.
export function _exitConfirmEnabled() {
    try { return localStorage.getItem('confirmExitSong') === '1'; } catch (_) { return false; }
}

const SPEED_PRESET_PCTS = [100, 90, 80, 75, 70, 60, 50];
const SPEED_SNAP_THRESHOLD = 0.02;
let _speedPresetsWired = false;

function _speedPresetPctFromActive(activePctOrRate) {
    if (!Number.isFinite(activePctOrRate)) return null;
    const rate = activePctOrRate <= 1.5 ? activePctOrRate : activePctOrRate / 100;
    for (const pct of SPEED_PRESET_PCTS) {
        if (Math.abs(rate - pct / 100) <= SPEED_SNAP_THRESHOLD) return pct;
    }
    return null;
}

function _updateSpeedPresetButtons(activePctOrRate) {
    const wrap = document.getElementById('speed-presets');
    if (!wrap) return;
    const target = _speedPresetPctFromActive(activePctOrRate);
    for (const btn of wrap.querySelectorAll('[data-speed-preset]')) {
        const pct = Number(btn.dataset.speedPreset);
        btn.classList.toggle('v3-speed-preset-active', target !== null && pct === target);
    }
}

export function applySpeedPreset(percent) {
    const slider = document.getElementById('speed-slider');
    if (!slider) return;
    const pct = Math.max(
        Number(slider.min) || 15,
        Math.min(Number(slider.max) || 150, Number(percent)),
    );
    if (!Number.isFinite(pct)) return;
    slider.value = String(pct);
    host.handleSliderInput(slider);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
}

export function _wireSpeedPresetsOnce() {
    if (_speedPresetsWired) return;
    const presets = document.getElementById('speed-presets');
    if (!presets) return;
    _speedPresetsWired = true;
    presets.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-speed-preset]');
        if (!btn) return;
        applySpeedPreset(Number(btn.dataset.speedPreset));
    });
}

export function setSpeed(v) {
    const speedSlider = document.getElementById('speed-slider');
    const rate = Number(v);
    if (!Number.isFinite(rate)) {
        return;
    }
    if (window._juceMode) {
        window.jucePlayer?.setRate(rate);
        const juceAudio = window.feedBackDesktop?.audio;
        Promise.resolve()
            .then(() => juceAudio?.setBackingSpeed(rate))
            // Match the HTML5 path: preserve pitch on the JUCE backing track too.
            // Optional-chained call is a no-op on desktop builds that predate
            // setBackingPreservePitch, so this is safe to ship unconditionally.
            .then(() => juceAudio?.setBackingPreservePitch?.(true))
            .catch(err => console.warn('[setSpeed] backing speed/preserve-pitch failed:', err));
    } else {
        audio.playbackRate = rate;
    }
    const speedLabel = document.getElementById('speed-label');
    if (speedLabel) speedLabel.textContent = rate.toFixed(2) + 'x';
    host.handleSliderInput(speedSlider);
    _updateSpeedPresetButtons(rate);
}

export function _resetPlaybackSpeedForNewSong() {
    // Reset the *actual* playback rate to 1x, not just the visible slider/label
    // (feedBack#615). The HTML5 <audio> element and the desktop JUCE/backing
    // engine each retain their own rate, and which one drives the next song
    // isn't decided until later in the load, so reset all paths unconditionally.
    // Every setter is idempotent and optional-chained, so this is safe in web
    // and desktop builds alike — no need to branch on window._juceMode.
    const speedSlider = document.getElementById('speed-slider');
    if (speedSlider) speedSlider.value = 100;
    audio.playbackRate = 1;
    window.jucePlayer?.setRate?.(1);
    const juceAudio = window.feedBackDesktop?.audio;
    Promise.resolve()
        .then(() => juceAudio?.setBackingSpeed?.(1))
        .then(() => juceAudio?.setBackingPreservePitch?.(true))
        .catch(err => console.warn('[resetSpeed] backing speed/preserve-pitch failed:', err));
    // Mirror setSpeed's UI side-effects (label text + slider fill styling).
    const speedLabel = document.getElementById('speed-label');
    if (speedLabel) speedLabel.textContent = (1).toFixed(2) + 'x';
    host.handleSliderInput(speedSlider);
    _updateSpeedPresetButtons(100);
}
// Master-difficulty slider (feedBack#48). Persists partial via
// /api/settings — the POST handler merges only the keys present, so
// this fire-and-forget call doesn't clobber dlc_dir or other settings.
//
// Debounced trailing-edge (300ms) so dragging the slider — which fires
// oninput per pixel — doesn't flood the server with concurrent writes
// to config.json. window.highway.setMastery() still fires every oninput so
// the chart re-filters in real time; only disk persistence waits.
let _masteryPersistTimer = null;
function _persistMastery(pct) {
    if (_masteryPersistTimer) clearTimeout(_masteryPersistTimer);
    _masteryPersistTimer = setTimeout(() => {
        _masteryPersistTimer = null;
        fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ master_difficulty: pct }),
        }).catch(() => { /* best-effort — next setMastery() will retry */ });
    }, 300);
}
export function setMastery(v) {
    _applyMastery(v);
}
// Shared mastery applier. Master difficulty has two controls that write the
// same master_difficulty key: the player-popover slider (#mastery-slider) and
// the Gameplay-tab "Note highway speed" slider (#setting-highway-speed). Route
// both — and loadSettings' hydration — through here so their positions,
// labels, and track fills stay in sync regardless of which the user touches,
// plus the live highway re-filter and the debounced persist. All element reads
// are null-guarded since either control may be absent (follower window, or the
// settings markup not yet rendered).
export function _applyMastery(v, opts = {}) {
    // Guard + clamp: v might be a slider string, a programmatic call from a
    // plugin, or a restored settings value with a bad shape. Don't let NaN
    // reach a label (would show "NaN%") or the POST.
    const parsed = parseInt(v, 10);
    if (!Number.isFinite(parsed)) return;
    const pct = Math.max(0, Math.min(100, parsed));
    const popLabel = document.getElementById('mastery-label');
    if (popLabel) popLabel.textContent = pct + '%';
    const popSlider = document.getElementById('mastery-slider');
    if (popSlider) {
        if (String(popSlider.value) !== String(pct)) popSlider.value = pct;
        host.handleSliderInput(popSlider);
    }
    const setSlider = document.getElementById('setting-highway-speed');
    if (setSlider) {
        if (String(setSlider.value) !== String(pct)) setSlider.value = pct;
        host.handleSliderInput(setSlider);
    }
    // The Gameplay-tab label markup appends a literal "%" after this span
    // (matching the av-offset "ms" pattern), so write the number alone here —
    // unlike #mastery-label above, whose markup carries no trailing unit.
    const setLabel = document.getElementById('setting-highway-speed-val');
    if (setLabel) setLabel.textContent = pct;
    window.highway.setMastery(pct / 100);
    if (!opts.skipPersist) _persistMastery(pct);
}
// Reflect phrase-data availability on the slider after every `ready`.
// The server omits the `phrases` message entirely for single-level
// sources (GP imports, legacy sloppak), so hasPhraseData() is the
// right signal to enable/disable the slider.
export function _applyMasteryAvailability(hasPhraseData) {
    const slider = document.getElementById('mastery-slider');
    if (!slider) return;
    if (hasPhraseData) {
        slider.disabled = false;
        slider.title = 'Master difficulty — low = simpler chart, high = full';
    } else {
        slider.disabled = true;
        slider.title = 'Source chart has a single difficulty level — slider disabled';
    }
}
