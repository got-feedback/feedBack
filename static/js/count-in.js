// Count-in — the 1-2-3-4 click before playback, plus the song-credits overlay that
// shares its lifecycle and timers.
//
// The third slice out of app.js's strongly-connected core, and the first that had to
// WRITE shared state rather than just read it. It starts and stops playback, so it sets
// `isPlaying` and `lastAudioTime`. An imported binding is read-only — `isPlaying = true`
// throws — which is exactly why those two scalars were lifted onto the container in
// ./player-state.js. Every earlier slice only READ what it shared, so a getter hook
// sufficed; this one could not.
//
// It imports the loop module directly (setLoop / loopA / loopB — a count-in that starts
// inside an A-B loop must begin at A). Nothing imports count-in back: app.js and
// section-practice both reach it through the host seam, so the graph stays acyclic.
//
// app.js's autoplay path used to reach IN and set the credits timers itself. It cannot
// now, and it should not have to — so the module exports the OPERATIONS instead
// (armCreditsHideOnPlay, scheduleCreditsHide, holdCreditsThen, isCountingIn) and owns
// its own timer invariants. Same reason section-practice grew resetSelection().
//
// See ./host.js: reading an unwired hook THROWS, and tests/js/host_contract.test.js
// fails CI if the hooks used here and the hooks app.js wires ever drift apart.
import { audio } from './audio-el.js';
import { _audioSeek, _songEventPayload, jucePlayer, setPlayButtonState, togglePlay } from './transport.js';
import { loopA, loopB, setLoop } from './loops.js';
import { S } from './player-state.js';

// ── Count-in click sound (Web Audio API) ────────────────────────────────
let _audioCtx = null;
export function playClick(high = false) {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = _audioCtx.createOscillator();
    const gain = _audioCtx.createGain();
    osc.connect(gain);
    gain.connect(_audioCtx.destination);
    osc.frequency.value = high ? 1200 : 800;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.5, _audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, _audioCtx.currentTime + 0.08);
    osc.start(_audioCtx.currentTime);
    osc.stop(_audioCtx.currentTime + 0.08);
}

let _countingIn = false;
let _countOverlay = null;
// Generation token so teardown can cancel an in-progress count-in. Each
// startCountIn() captures the gen at entry; rewindStep, the loop-wrap
// then-callback, and beginCount's tick all bail when their captured gen
// no longer matches. Bumped by _cancelCountIn().
let _countInGen = 0;
let _countInTimer = null;
let _countInRaf = 0;
// Feedpak credits overlay (manifest `authors:`, spec §5.4): shown on the
// highway when a song is loaded, alongside the count-in. Torn down together
// with the count-in via _cancelCountIn().
let _creditsOverlay = null;
let _creditsTimer = null;
let _creditsHideOnPlay = null;
let _creditsMaxTimer = null;
const _CREDITS_HOLD_MS = 3000;
// Backstop: the overlay's primary dismiss is song:play, but playback can fail
// to start without emitting it (HTML5 autoplay rejection, JUCE start failure,
// a count-in handoff that never plays). This hard cap guarantees the credits
// never linger over the window.highway. Generous enough to outlast a normal count-in.
const _CREDITS_MAX_MS = 12000;
export function _cancelCountIn() {
    _countInGen++;
    _countingIn = false;
    hideCountOverlay();
    // The credits overlay rides the count-in lifecycle (and its no-count-in
    // hold timer), so a teardown — leaving the player, loading another song —
    // must clear it too, or it lingers on the next screen.
    hideSongCreditsOverlay();
    if (_countInTimer) { clearTimeout(_countInTimer); _countInTimer = null; }
    if (_countInRaf) { cancelAnimationFrame(_countInRaf); _countInRaf = 0; }
}

export function showCountOverlay(n) {
    if (!_countOverlay) {
        _countOverlay = document.createElement('div');
        _countOverlay.className = 'fixed inset-0 z-[100] flex items-center justify-center pointer-events-none';
        document.body.appendChild(_countOverlay);
    }
    _countOverlay.innerHTML = `<span class="text-9xl font-black text-white/30">${n}</span>`;
}

export function hideCountOverlay() {
    if (_countOverlay) { _countOverlay.remove(); _countOverlay = null; }
}

// Map a feedpak author `role` to a friendly "<verb> by" credit line. The
// recommended vocabulary is from feedpak spec §5.4; unknown roles are
// title-cased ("foo" → "Foo by"); a missing role shows the bare name.
const _CREDIT_ROLE_VERBS = {
    charter: 'Charted by',
    transcriber: 'Transcribed by',
    arranger: 'Arranged by',
    editor: 'Edited by',
    mixer: 'Mixed by',
    engineer: 'Engineered by',
    proofreader: 'Proofread by',
};

function _creditLineLabel(role) {
    if (!role) return '';
    const key = String(role).trim().toLowerCase();
    if (_CREDIT_ROLE_VERBS[key]) return _CREDIT_ROLE_VERBS[key];
    return key.charAt(0).toUpperCase() + key.slice(1) + ' by';
}

// Show the feedpak contributor credits over the window.highway. `authors` is the
// sanitized [{name, role}] list from window.feedBack.currentSong.authors.
// Anchored to the lower third (bottom-center) so it never collides with the
// vertically-centered count-in number, and pointer-events-none so it never
// intercepts clicks. No-op when there are no contributors to show.
export function showSongCreditsOverlay(authors) {
    if (!Array.isArray(authors) || authors.length === 0) return;
    if (!_creditsOverlay) {
        _creditsOverlay = document.createElement('div');
        _creditsOverlay.className = 'song-credits-overlay';
        document.body.appendChild(_creditsOverlay);
    }
    // Build via DOM + textContent — author names are untrusted pack data and
    // must never be interpolated as HTML.
    _creditsOverlay.replaceChildren();
    const card = document.createElement('div');
    card.className = 'song-credits-card';

    const eyebrow = document.createElement('div');
    eyebrow.className = 'song-credits-eyebrow';
    eyebrow.textContent = 'Credits';
    card.appendChild(eyebrow);

    const title = (window.feedBack && window.feedBack.currentSong
        && window.feedBack.currentSong.title) || '';
    if (title) {
        const heading = document.createElement('div');
        heading.className = 'song-credits-heading';
        heading.textContent = title;
        card.appendChild(heading);
    }

    for (const a of authors) {
        if (!a || !a.name) continue;
        const row = document.createElement('div');
        row.className = 'song-credits-line';
        const label = _creditLineLabel(a.role);
        if (label) {
            const lab = document.createElement('span');
            lab.className = 'song-credits-role';
            lab.textContent = label + ' ';
            row.appendChild(lab);
        }
        const nm = document.createElement('span');
        nm.className = 'song-credits-name';
        nm.textContent = a.name;
        row.appendChild(nm);
        card.appendChild(row);
    }
    _creditsOverlay.appendChild(card);
    // Arm the backstop so the overlay self-clears even if playback never starts
    // / never emits song:play. song:play (or any teardown) clears it earlier.
    if (_creditsMaxTimer) clearTimeout(_creditsMaxTimer);
    _creditsMaxTimer = setTimeout(hideSongCreditsOverlay, _CREDITS_MAX_MS);
}

export function hideSongCreditsOverlay() {
    if (_creditsTimer) { clearTimeout(_creditsTimer); _creditsTimer = null; }
    if (_creditsMaxTimer) { clearTimeout(_creditsMaxTimer); _creditsMaxTimer = null; }
    if (_creditsHideOnPlay) {
        window.feedBack.off('song:play', _creditsHideOnPlay);
        _creditsHideOnPlay = null;
    }
    if (_creditsOverlay) { _creditsOverlay.remove(); _creditsOverlay = null; }
}

export async function startCountIn(opts = {}) {
    if (_countingIn) return;
    _countingIn = true;
    // Snapshot the current gen so every delayed callback (rewind frames,
    // post-seek then, count-in ticks, post-count play) can bail if a
    // teardown bumped the gen mid-flight via _cancelCountIn().
    const gen = _countInGen;
    const immediate = !!opts.immediate;
    if (window._juceMode) {
        await jucePlayer.pause().catch((err) => console.error('[app] jucePlayer.pause error in count-in:', err));
    } else {
        audio.pause();
    }
    if (gen !== _countInGen) return; // teardown during pause

    // Section-practice entry: already at loop A after setLoop(); skip the
    // B→A rewind animation used on loop wrap and go straight to clicks.
    if (immediate) {
        if (loopA === null || loopB === null) {
            _countingIn = false;
            return;
        }
        S.lastAudioTime = loopA;
        window.highway.setTime(loopA);
        if (window.feedBack) {
            window.feedBack.emit('loop:restart', { loopA, loopB, time: loopA });
        }
        beginCount();
        return;
    }

    // Rewind animation: sweep highway time from B to A
    const rewindDuration = 400; // ms
    const rewindStart = performance.now();
    const fromTime = loopB;
    const toTime = loopA;

    function rewindStep(now) {
        if (gen !== _countInGen) return; // teardown mid-rewind
        const elapsed = now - rewindStart;
        const t = Math.min(elapsed / rewindDuration, 1);
        // Ease out quad
        const eased = 1 - (1 - t) * (1 - t);
        const currentT = fromTime + (toTime - fromTime) * eased;
        window.highway.setTime(currentT);
        if (t < 1) {
            _countInRaf = requestAnimationFrame(rewindStep);
        } else {
            _countInRaf = 0;
            // Rewind done — set final position and start count.
            // Await the JUCE seek so the engine has repositioned before
            // we start the click track (HTML5 path is synchronous).
            _audioSeek(loopA, 'loop-wrap').then((r) => {
                if (gen !== _countInGen) return; // teardown during seek
                // Abort the loop restart in two cases:
                //   1. Cancelled (player torn down): don't beginCount on a
                //      new session.
                //   2. Off-target landing (JUCE rollback / clamp far from
                //      loopA): proceeding would emit loop:restart and start
                //      a count-in from the wrong position. Audio is at
                //      r.from / r.to, which is not where the loop wants to
                //      resume — better to drop this iteration than play out
                //      of sync.
                // 50 ms tolerance: well within JUCE's normal seek precision
                // but tight enough to catch a real rollback or no-op.
                if (!r.completed || Math.abs(r.to - loopA) > 0.05) {
                    // startCountIn paused audio at entry but left isPlaying
                    // alone — beginCount would have set it on resume. On
                    // abort, sync the transport: audio is paused, so
                    // isPlaying must reflect that and the button + plugin
                    // host must agree.
                    _countingIn = false;
                    if (S.isPlaying) {
                        S.isPlaying = false;
                        setPlayButtonState(false);
                        if (window.feedBack) {
                            window.feedBack.isPlaying = false;
                            window.feedBack.emit('song:pause', _songEventPayload());
                        }
                    }
                    return;
                }
                // Use the verified post-seek clock for the chart so audio
                // and chart stay in sync if JUCE clamped to slightly
                // before/after loopA. The loop:restart event keeps `time:
                // loopA` because subscribers treat that as the semantic
                // marker for "new iteration starts at A", not the actual
                // audio position.
                S.lastAudioTime = r.to;
                window.highway.setTime(r.to);
                window.feedBack.emit('loop:restart', { loopA, loopB, time: loopA });
                beginCount();
            });
        }
    }
    _countInRaf = requestAnimationFrame(rewindStep);

    function beginCount() {
        const bpm = window.highway.getBPM(loopA);
        const beatInterval = 60 / bpm;
        let count = 0;

        function tick() {
            if (gen !== _countInGen) return; // teardown mid-count
            count++;
            if (count > 4) {
                hideCountOverlay();
                _countingIn = false;
                if (window._juceMode) {
                    jucePlayer.play().then((started) => {
                        if (gen !== _countInGen) return; // teardown during play start
                        if (!started) return;
                        S.isPlaying = true;
                        setPlayButtonState(true);
                        window.feedBack.isPlaying = true;
                        const payload = _songEventPayload();
                        window.feedBack.emit('song:play', payload);
                        window.feedBack.emit('song:resume', payload);
                    }).catch((err) => console.error('[app] jucePlayer.play error:', err));
                } else {
                    audio.play().then(() => {
                        if (gen !== _countInGen) return;
                        S.isPlaying = true;
                        setPlayButtonState(true);
                    }).catch((err) => {
                        if (gen !== _countInGen) return;
                        // An engine reroute's deliberate pause aborts this play()
                        // while playback continues on JUCE — don't reset the
                        // button (mirrors the togglePlay guard).
                        if (window._juceRerouteInProgress) return;
                        // Same rationale as togglePlay: don't claim playback
                        // started if the Promise rejected.
                        console.error('[app] audio.play() rejected after count-in:', err);
                        S.isPlaying = false;
                        setPlayButtonState(false);
                    });
                }
                return;
            }
            showCountOverlay(count);
            playClick(count === 1);
            _countInTimer = setTimeout(tick, beatInterval * 1000);
        }
        _countInTimer = setTimeout(tick, 500);
    }
}

// Start-of-song count-in: a 4-beat click before playback begins, gated by the
// "Countdown before song" setting (Gameplay tab). Mirrors the loop count-in's
// overlay + click + gen-token cancellation, but counts from the song's current
// position (0 at song start) with no loop A/B rewind. startCountIn() is loop-
// coupled (early-returns when loopA/loopB are null), so this is a sibling
// rather than an overload. Hands off to togglePlay() once the count completes.
export async function startSongCountIn() {
    if (_countingIn) return;
    _countingIn = true;
    // Snapshot the gen so a teardown (showScreen/playSong calls _cancelCountIn)
    // bumps it and every delayed callback below bails.
    const gen = _countInGen;
    if (window._juceMode) {
        await jucePlayer.pause().catch((err) => console.error('[app] jucePlayer.pause error in song count-in:', err));
    } else {
        audio.pause();
    }
    if (gen !== _countInGen) return; // teardown during pause
    const startT = S.lastAudioTime || 0;
    let bpm = window.highway.getBPM(startT);
    // Pre-chart / malformed-tempo fallback: 4 beats at 120 BPM (500 ms each).
    if (!Number.isFinite(bpm) || bpm <= 0) bpm = 120;
    const beatInterval = 60 / bpm;
    let count = 0;
    function tick() {
        if (gen !== _countInGen) return; // teardown mid-count
        count++;
        if (count > 4) {
            hideCountOverlay();
            _countingIn = false;
            // Hand off to the normal play path — togglePlay() flips isPlaying,
            // updates the button, and emits song:play/resume for plugins.
            Promise.resolve(togglePlay()).catch((err) => console.warn('[app] play after count-in failed:', err));
            return;
        }
        showCountOverlay(count);
        playClick(count === 1);
        _countInTimer = setTimeout(tick, beatInterval * 1000);
    }
    // First beat after a short lead-in, matching the loop count-in's 500 ms.
    _countInTimer = setTimeout(tick, 500);
}

// ── Operations app.js's autoplay path used to perform by reaching in ────────
// It used to assign _creditsTimer / _creditsHideOnPlay directly. Imported bindings are
// read-only, and the module should own its own timer invariants anyway.

/** Is a count-in running? app.js's timeupdate handler suppresses highway sync during one. */
export function isCountingIn() {
    return _countingIn;
}

/** Dismiss the credits the moment real playback begins. Fires once. */
export function armCreditsHideOnPlay() {
    _creditsHideOnPlay = () => { _creditsHideOnPlay = null; hideSongCreditsOverlay(); };
    window.feedBack.on('song:play', _creditsHideOnPlay, { once: true });
}

/** Let the credits dwell, then clear them. Used when autoplay-exit is disabled. */
export function scheduleCreditsHide() {
    _creditsTimer = setTimeout(hideSongCreditsOverlay, _CREDITS_HOLD_MS);
}

/** Let the credits dwell, then run `then` (the autoplay start). */
export function holdCreditsThen(then) {
    _creditsTimer = setTimeout(() => { _creditsTimer = null; then(); }, _CREDITS_HOLD_MS);
}
