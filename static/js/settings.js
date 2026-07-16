// Settings: load/save, the AV-offset nudge, the default-arrangement pin, the instrument
// pathway, and the app-update channel.
//
// INTERFACE WIDTH 1 — app.js calls loadSettings() and nothing else. It got that clean by
// PULLING THE WRITERS IN: _defaultArrangement was the one binding written from outside the
// cluster, by saveSettings and pinCurrentArrangementDefault — which are themselves settings
// functions. Widening the slice to include them left ZERO outside writes, so every export is a
// plain read-only import and no state container is needed.
//
// (An imported binding is read-only. One write from outside would have forced a setter or a
// container, as it did for the player and the library. Here the fix was to draw the boundary in
// the right place instead.)
//
// ─── handleSliderInput STAYS A HOST HOOK, DELIBERATELY ───────────────────────
//
// It lives here (it is a settings control), but player-controls.js must NOT import it: this
// module already imports player-controls (_applyMastery, _autoplayExitEnabled, …), so a direct
// back-import would close a cycle. player-controls keeps reading it through the host seam, and
// app.js — the root, which imports both — wires it. That is exactly what the seam is for.
import { hwcInitSettingsUI } from './highway-colors.js';
import { _getArrangementNamingMode } from './library.js';
import {
    _applyMastery, _autoplayExitEnabled, _exitConfirmEnabled, _showUpNextEnabled,
} from './player-controls.js';

// ── Settings ─────────────────────────────────────────────────────────────
export let _defaultArrangement = '';

export const INSTRUMENT_PATHWAYS = ['songs', 'practice', 'learn', 'studio'];

export function _normalizeInstrumentPathway(value) {
    return INSTRUMENT_PATHWAYS.includes(value) ? value : 'songs';
}

export function _syncDefaultArrangementSelect(value) {
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

export function _currentArrangementName() {
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

export function syncDefaultArrangementPin() {
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

export async function pinCurrentArrangementDefault() {
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

export async function loadSettings() {
    // App Updates UI does not depend on /api/settings — run it first so a
    // failed fetch below still leaves the desktop updater wired up.
    // setupAppUpdates() is idempotent via _appUpdatesWired.
    setupAppUpdates();
    setupWindowOptions();
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

// ── Window options (desktop-only) ────────────────────────────────────────
// Desktop-only window preferences (start-in-fullscreen, …). The whole block
// stays hidden in the plain web / Docker app; unhide + wire only when the
// feedBack-desktop bridge (window.feedBackDesktop.window) exposes the getter
// and setter. Persistence lives desktop-side because only the Electron main
// process can read the pref at window-creation time — core just proxies.
export let _windowOptionsWired = false;

export function setupWindowOptions() {
    const block = document.getElementById('window-options-block');
    if (!block) return;
    const winApi = window.feedBackDesktop?.window;
    // Per-method capability check: a partial/older bridge may expose `window`
    // without this shape. Leave the block hidden rather than half-wiring it.
    if (!winApi
        || typeof winApi.getStartFullscreen !== 'function'
        || typeof winApi.setStartFullscreen !== 'function') {
        return;
    }

    block.classList.remove('hidden');

    const cb = document.getElementById('setting-start-fullscreen');
    if (!cb) return;

    // Hydrate from the desktop-persisted value. The getter may be sync or
    // async (IPC round-trip); Promise.resolve normalises both.
    Promise.resolve(winApi.getStartFullscreen()).then(function (on) {
        cb.checked = !!on;
    }).catch(function () { /* leave unchecked on error */ });

    // Guard only the listener against double-binding; unhide + re-hydrate
    // stay idempotent so re-entering Settings refreshes the checkbox.
    if (!_windowOptionsWired) {
        _windowOptionsWired = true;
        cb.addEventListener('change', function () {
            try { winApi.setStartFullscreen(cb.checked); } catch (_) { /* best-effort */ }
        });
    }
}

export const APP_UPDATE_CHANNELS = ['stable', 'rc', 'beta', 'alpha', 'nightly'];

export let _appUpdatesWired = false;

export function setupAppUpdates() {
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

    function showLinuxFallback(message) {
        // Deliberately leaves channelSelect ENABLED: on Linux "unsupported"
        // usually just means "the channel isn't Nightly yet", and the dropdown
        // is the only way to switch to Nightly. Disabling it would trap the
        // user on whatever channel they booted with. Only the check button and
        // the note reflect the unsupported state.
        if (linuxNote) linuxNote.classList.remove('hidden');
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
                    showLinuxFallback('Auto-update requires the AppImage build on the Nightly channel.');
                    return;
                }
                // Status is healthy for the current channel — clear any
                // "unsupported" UI left over from a prior channel selection.
                if (linuxNote) linuxNote.classList.add('hidden');
                checkBtn.disabled = false;
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

    // Inform main of the persisted channel on each load. setChannel() on
    // main is idempotent when the channel already matches. On Linux this is
    // how the panel reaches a supported state: booting on 'stable' reports
    // unsupported, and switching the dropdown to Nightly re-checks below.
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
                        showLinuxFallback('Auto-update requires the AppImage build on the Nightly channel.');
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

// Updates the fill on slider elements. Expects a CSS variable --range-pct used
// in the track fill styling. Declared as a function (not a const) so it is
// hoisted onto window — audio-mixer.js calls it as window.handleSliderInput,
// matching the window.playSong / window.showScreen cross-script convention.
export function handleSliderInput(el) {
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
export let _avOffsetMs = 0;

export let _avSaveDebounce = null;

export function setAvOffsetMs(ms, skipPersist) {
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

export function _persistAvOffset() {
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

export function nudgeAvOffsetMs(delta) {
    setAvOffsetMs(Math.max(-1000, Math.min(1000, _avOffsetMs + delta)));
}

export async function saveSettings() {
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
export let _settingSaveChain = Promise.resolve();

export function persistSetting(key, value) {
    const next = _settingSaveChain.then(() => _postSetting(key, value));
    // Swallow failures so one failed write doesn't poison the chain and
    // block every later save.
    _settingSaveChain = next.catch(() => {});
    return next;
}

export function setInstrumentPathway(value) {
    const pathway = _normalizeInstrumentPathway(value);
    const el = document.getElementById('setting-instrument-pathway');
    if (el) el.value = pathway;
    persistSetting('pathway', pathway).then(() => {
        if (window.v3Badges && typeof window.v3Badges.reload === 'function') {
            try { window.v3Badges.reload(); } catch (_) { /* noop */ }
        }
    });
}

export async function _postSetting(key, value) {
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
