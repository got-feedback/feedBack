// The desktop (JUCE) audio integration — three self-installing shims.
//
// The largest single slice out of app.js's core: 938 lines, ~12% of what was left.
//
//   _installJuceEngineRoutingWatcher  routes a song to the JUCE engine or HTML5 as the
//                                     desktop output device enters/leaves exclusive/ASIO
//   _installRendererBusFeeder         feeds the highway renderer bus from whichever
//                                     transport is actually running
//   _installJuceAudioElementShim      patches audio.play/pause so the rest of the app
//                                     can keep talking to the <audio> element while JUCE
//                                     owns the transport
//
// They EXPORT NOTHING. All three are IIFEs that publish through `window.*`
// (_juceMode, _reevaluateJuceRouting, _reevaluateRendererBus, …) — which is why app.js
// only needs a side-effect import for two of them, plus _resetJuceAudioShimChain.
//
// ORDERING, CHECKED: importing this module runs the IIFEs EARLIER than before —
// imports evaluate ahead of app.js's body, and therefore ahead of configureHost().
// That is safe because none of them touches a hook at execution depth: they only
// register listeners and patch audio.play/pause (and `audio` is itself an imported
// module now). Verified by walking the AST at IIFE-body depth. If a hook were ever
// read there it would THROW loudly — see ./host.js — rather than silently misbehave.
//
// See ./host.js: reading an unwired hook THROWS, and tests/js/host_contract.test.js
// fails CI if the hooks used here and the hooks app.js wires ever drift apart.
import { audio } from './audio-el.js';
import { _audioSeek, _songEventPayload, jucePlayer, setPlayButtonState } from './transport.js';
import { setSpeed } from './player-controls.js';
import { S } from './player-state.js';

(function _installJuceEngineRoutingWatcher() {
    const juceApi = window.feedBackDesktop?.audio;
    if (!juceApi || typeof juceApi.isAudioRunning !== 'function') {
        // Desktop bridge present but audio API incomplete — the whole
        // exclusive reroute chain is dead and this line is the only witness.
        // (Docker sphere has no bridge at all: stay silent, nothing to
        // diagnose there and no debug flag to gate on.)
        if (window.feedBackDesktop) {
            console.log('[asio-diag] routing watcher NOT installed (audio api incomplete)');
        }
        return;
    }

    let _rerouteInFlight = false;
    // URL that JUCE's loadBackingTrack *explicitly rejected* (ok === false —
    // e.g. a codec it can't read). The poll below would otherwise retry the
    // same doomed track every 350 ms; remember it and skip until the song
    // changes. Only a hard JUCE reject is memoised here — transient failures
    // (a network blip on /api/audio-local-path, an isAudioRunning() race
    // during a device restart) are deliberately NOT memoised so they retry.
    let _rerouteRejectedUrl = null;
    // Exclusive-style output backends silence every other client on the
    // endpoint — including our own <audio> element. The share mode IS the
    // JUCE output device type: "Windows Audio (Exclusive Mode)" is a
    // hardcoded, unlocalised JUCE type name; ASIO drivers typically hold
    // the endpoint exclusively too. "Windows Audio (Low Latency Mode)" is
    // shared and must NOT match.
    function _isExclusiveOutputType(t) {
        return t === 'Windows Audio (Exclusive Mode)' || t === 'ASIO';
    }
    // [feedpak-route] diagnostics: log the raw outputType string once per
    // value change (this runs on a 350ms poll — logging every tick would
    // flood the diagnostics buffer).
    let _loggedOutputType;
    // [asio-diag] verbose diagnostics, gated on --debug (preload exposes
    // audio.debugEnabled). Resolved once at install; until it resolves the
    // flag stays false and verbose lines are skipped. Shared with the
    // renderer-bus feeder below via window._asioDiagEnabled.
    let _asioDiag = false;
    if (typeof juceApi.debugEnabled === 'function') {
        juceApi.debugEnabled().then((v) => {
            _asioDiag = !!v;
            // Deferred install line: the flag resolves async, so logging at
            // IIFE entry would race it. Change-detection isn't needed — this
            // runs once per page load.
            if (_asioDiag) console.log('[asio-diag] routing watcher installed');
        }).catch(() => {});
    }
    window._asioDiagEnabled = () => _asioDiag;
    async function _outputIsExclusive() {
        if (typeof juceApi.getCurrentDevice !== 'function') {
            if (_loggedOutputType !== '<no-getCurrentDevice>') {
                _loggedOutputType = '<no-getCurrentDevice>';
                console.warn('[feedpak-route] juceApi.getCurrentDevice missing — cannot detect exclusive output');
            }
            return false;
        }
        try {
            const dev = await juceApi.getCurrentDevice();
            const t = dev?.outputType || dev?.type || '';
            const excl = _isExclusiveOutputType(t);
            if (t !== _loggedOutputType) {
                _loggedOutputType = t;
                console.log('[feedpak-route] outputType=', JSON.stringify(t), '→ exclusive=', excl);
                // [asio-diag] full device object on every type change — shows
                // the exact strings the predicate saw (inputType vs outputType,
                // device names, duplex), so a driver reporting a non-'ASIO'
                // type name is visible in tester logs.
                if (_asioDiag) {
                    try {
                        console.log('[asio-diag] getCurrentDevice=', JSON.stringify(dev));
                    } catch (_) { /* circular/hostile object — skip */ }
                }
            }
            return excl;
        } catch (e) {
            if (_loggedOutputType !== '<getCurrentDevice-failed>') {
                _loggedOutputType = '<getCurrentDevice-failed>';
                console.warn('[feedpak-route] getCurrentDevice failed:', e);
            }
            return false;
        }
    }
    // window.highway.js's initial song-load routing consults this for the same
    // feedpak-under-exclusive decision the watcher makes below.
    window._juceOutputIsExclusive = _outputIsExclusive;
    // Returns true when window._currentSongAudio no longer references the exact
    // snapshot object captured at reroute entry — i.e. the song was swapped (or
    // cleared) mid-flight. Staleness is detected by object-reference identity,
    // not by URL value.
    function _isStale(songAudio) {
        return window._currentSongAudio !== songAudio;
    }

    // Migrates the loaded song from the HTML5 element onto the JUCE backing
    // transport. Throws only on transient/unexpected failures.
    // `songAudio` is the snapshot captured at reroute entry; if it stops being
    // the current song mid-flight we abort without mutating global routing.
    // Returns a distinct string outcome — the caller must NOT conflate them:
    //   'switched' — song now plays via JUCE.
    //   'rejected' — JUCE hard-rejected the track (codec). Caller memoises it.
    //   'stale'    — the loaded song changed mid-flight; aborted, NOT memoised.
    // (a transient transport-start failure throws instead — also not memoised.)
    async function _switchHtml5ToJuce(songAudio) {
        const url = songAudio.url;
        const wasPlaying = S.isPlaying;
        const pos = audio.currentTime || 0;
        window.feedBack?.playback?.recordRouteChange?.({
            routeKind: 'desktop-native',
            state: 'switching',
            preservedTime: true,
            safeReason: 'desktop audio engine became active',
            requesterId: 'core.juce-route',
        });
        // Mark a reroute in progress so the <audio> 'play'/'pause' listeners
        // suppress their song:play / song:pause emissions: the migration is
        // transparent — playback genuinely continues — so plugin state and
        // window.feedBack.isPlaying must NOT flip. This also silences the
        // "Audio paused unexpectedly" diagnostic. A REFCOUNT (not a boolean)
        // lets an overlapping reroute's deferred release coexist: each switch
        // increments on entry and decrements after its own timeout; listeners
        // treat any count > 0 as "reroute active".
        window._juceRerouteInProgress = (window._juceRerouteInProgress || 0) + 1;
        audio.pause();
        try {
            const res = await fetch(`/api/audio-local-path?url=${encodeURIComponent(url)}`);
            if (!res.ok) {
                console.warn('[feedpak-route] audio-local-path HTTP', res.status, 'for', url);
                throw new Error('HTTP ' + res.status);
            }
            const { path } = await res.json();
            console.log('[feedpak-route] audio-local-path resolved:', (typeof path === 'string' && path.split(/[\\/]/).pop()) || '<missing>');
            if (_isStale(songAudio)) return 'stale';   // song changed mid-fetch
            const ok = await juceApi.loadBackingTrack(path);
            if (ok === false) {
                // JUCE rejected the track — stay on HTML5, resume if needed.
                console.warn('[juce-reroute] loadBackingTrack rejected; staying on HTML5');
                // Only resume if the element still has a source. In the normal
                // flow audio.src is intact here, but a prior HTML5→JUCE switch
                // clears it — re-point + load before resuming so a bounced
                // reroute doesn't try to play() an empty element.
                if (S.isPlaying && !_isStale(songAudio)) {
                    if (!audio.src) { audio.src = url; audio.load(); }
                    try { await audio.play(); } catch (_) { /* ignore */ }
                }
                window.feedBack?.playback?.recordRouteChange?.({
                    routeKind: 'browser-media',
                    state: 'degraded',
                    preservedTime: true,
                    safeReason: 'desktop audio route rejected track; kept browser media route',
                    requesterId: 'core.juce-route',
                });
                return 'rejected';
            }
            if (_isStale(songAudio)) return 'stale';
            const dur = await juceApi.getBackingDuration();
            await juceApi.seekBacking(pos);
            // Start the new transport BEFORE committing global routing state, so
            // a play() failure can't leave us in "JUCE mode, nothing playing"
            // (the silent-song state this watcher exists to prevent).
            // jucePlayer.play() RETURNS false (it does not throw) when
            // startBacking fails — check the result, don't just await it.
            // A play() failure is a TRANSIENT transport-start issue, not a hard
            // codec reject: throw (rather than returning 'rejected') so the
            // caller's catch path handles it WITHOUT memoising the URL, leaving
            // it free to retry on the next poll. Only 'rejected' is memoised.
            // Re-read isPlaying as late as possible: the user can press Pause
            // during the multi-await fetch/IPC chain above. Starting the JUCE
            // transport off a stale `wasPlaying` snapshot would resume a song
            // the user just paused. Only start it if playback is still wanted.
            if (S.isPlaying) {
                const started = await jucePlayer.play();
                if (started === false) {
                    if (!_isStale(songAudio) && S.isPlaying) {
                        try { await audio.play(); } catch (_) { /* ignore */ }
                    }
                    throw new Error('jucePlayer.play() failed (transient transport start)');
                }
            }
            if (_isStale(songAudio)) {
                // Song changed while JUCE was spinning up — undo and bail.
                await jucePlayer.pause().catch(() => {});
                return 'stale';
            }
            if (window.jucePlayer) {
                jucePlayer._dur = dur;
                jucePlayer._pos = pos;
                jucePlayer._pollAt = performance.now();
            }
            window._juceMode = true;
            window._juceAudioUrl = url;
            const _spSlider = document.getElementById?.('speed-slider');
            if (_spSlider) setSpeed(_spSlider.value / 100);
            audio.src = '';
            try {
                const apply = window.feedBack?.audio?.applySongVolume;
                if (typeof apply === 'function') await apply();
            } catch (_) { /* best-effort */ }
            console.log('[juce-reroute] HTML5 → JUCE @', pos.toFixed(2), 's playing=', wasPlaying);
            window.feedBack?.playback?.recordRouteChange?.({
                routeKind: 'desktop-native',
                state: 'active',
                preservedTime: true,
                safeReason: 'desktop audio route active',
                requesterId: 'core.juce-route',
            });
            return 'switched';
        } catch (err) {
            // Path lookup, JSON parse, or a JUCE IPC call threw partway through.
            // audio.pause() already ran above; restore HTML5 playback so a
            // previously playing song isn't left silently paused, then re-throw
            // so the caller logs it. The caller does NOT memoise this URL —
            // transient failures must retry on the next poll.
            if (S.isPlaying && !window._juceMode && !_isStale(songAudio)) {
                if (!audio.src) { audio.src = url; audio.load(); }
                try { await audio.play(); } catch (_) { /* ignore */ }
            }
            window.feedBack?.playback?.recordRouteChange?.({
                routeKind: 'browser-media',
                state: 'degraded',
                preservedTime: true,
                safeReason: 'desktop audio route failed; kept browser media route',
                requesterId: 'core.juce-route',
            });
            throw err;
        } finally {
            // Clearing audio.src above dispatches a 'pause' event in a later
            // task, after this synchronous finally. Defer the refcount
            // decrement so that trailing event is still suppressed; a 0ms
            // timeout lands after the pending pause-event task. Decrementing
            // (rather than zeroing) leaves any overlapping reroute's own
            // suppression intact.
            setTimeout(() => {
                window._juceRerouteInProgress = Math.max(
                    0, (window._juceRerouteInProgress || 1) - 1);
            }, 0);
        }
    }

    async function _switchJuceToHtml5(songAudio) {
        const url = songAudio.url;
        const wasPlaying = S.isPlaying;
        const pos = (window.jucePlayer ? jucePlayer.currentTime : 0) || 0;
        window.feedBack?.playback?.recordRouteChange?.({
            routeKind: 'browser-media',
            state: 'switching',
            preservedTime: true,
            safeReason: 'desktop audio engine stopped',
            requesterId: 'core.juce-route',
        });
        // Mark a reroute in progress (refcount) so the <audio> 'play' listener
        // suppresses its song:play emission — the migration is transparent and
        // playback genuinely continues, so plugin state must not flip. Held
        // until after the (possibly deferred) audio.play() event has fired.
        window._juceRerouteInProgress = (window._juceRerouteInProgress || 0) + 1;
        let _suppressionReleased = false;
        const _releaseSuppression = () => {
            if (_suppressionReleased) return;
            _suppressionReleased = true;
            // Defer so the 'play' (or 'pause') event task fires while still
            // suppressed; a 0ms timeout lands after it.
            setTimeout(() => {
                window._juceRerouteInProgress = Math.max(
                    0, (window._juceRerouteInProgress || 1) - 1);
            }, 0);
        };
        let _resumeScheduled = false;
        try {
            await jucePlayer.pause().catch(() => {});
            if (_isStale(songAudio)) return;           // song changed mid-pause
            window._juceMode = false;
            window._juceAudioUrl = null;
            audio.src = url;
            audio.load();
            const _spSlider = document.getElementById?.('speed-slider');
            if (_spSlider) setSpeed(_spSlider.value / 100);
            // Resume only AFTER the seek so playback starts at `pos`, not at 0
            // with an audible jump once metadata arrives.
            const resumeAtPos = () => {
                try {
                    // The metadata event can land after a fast song switch —
                    // bail before touching currentTime so a stale callback
                    // doesn't seek the newly loaded song to the old position.
                    if (_isStale(songAudio)) return;
                    try { audio.currentTime = pos; } catch (_) { /* ignore */ }
                    // Re-read isPlaying (not the entry snapshot): the user may
                    // have pressed Pause during jucePlayer.pause()/metadata
                    // load — don't resume a song they just paused.
                    if (S.isPlaying) {
                        audio.play().catch(() => { /* ignore */ });
                    }
                } finally {
                    _releaseSuppression();
                }
            };
            _resumeScheduled = true;
            if (audio.readyState >= 1) {
                resumeAtPos();
            } else {
                // Wait for metadata to resume at `pos`. But metadata may never
                // arrive (bad URL, network error) — that would leak the
                // suppression refcount and permanently silence song:play /
                // song:pause. Guard with the element's 'error' event AND a
                // backstop timeout; whichever fires first wins, the others are
                // detached. _releaseSuppression is idempotent regardless.
                let _settled = false;
                const _onMeta = () => { finish(true); };
                const _onErr = () => { finish(false); };
                let _backstop;
                function finish(reachedMetadata) {
                    if (_settled) return;
                    _settled = true;
                    clearTimeout(_backstop);
                    audio.removeEventListener('loadedmetadata', _onMeta);
                    audio.removeEventListener('error', _onErr);
                    if (reachedMetadata) {
                        resumeAtPos();             // resumeAtPos releases suppression
                    } else {
                        _releaseSuppression();     // no resume — just release
                    }
                }
                audio.addEventListener('loadedmetadata', _onMeta, { once: true });
                audio.addEventListener('error', _onErr, { once: true });
                // 10s is well beyond a normal local-file metadata load.
                _backstop = setTimeout(() => { finish(false); }, 10000);
            }
        } finally {
            // resumeAtPos owns the release once scheduled; if we returned
            // early (stale, before scheduling) release here instead.
            // _releaseSuppression is idempotent so an overlap is harmless.
            if (!_resumeScheduled) _releaseSuppression();
        }
        try {
            const apply = window.feedBack?.audio?.applySongVolume;
            if (typeof apply === 'function') await apply();
        } catch (_) { /* best-effort */ }
        console.log('[juce-reroute] JUCE → HTML5 @', pos.toFixed(2), 's playing=', wasPlaying);
        window.feedBack?.playback?.recordRouteChange?.({
            routeKind: 'browser-media',
            state: 'active',
            preservedTime: true,
            safeReason: 'browser media route active',
            requesterId: 'core.juce-route',
        });
    }

    async function _reevaluateJuceRouting() {
        if (_rerouteInFlight) return;
        const songAudio = window._currentSongAudio;
        // /audio/ songs are always JUCE-routable. A feedpak full-mix
        // (single-mix pack, no stems) is routable ONLY under an
        // exclusive-style output — in shared mode it must stay on HTML5 so
        // the stem mixer / WebAudio path keeps working. Sloppak stem URLs
        // are never routable (per-stem mix can't ride a single transport).
        if (!songAudio || (!songAudio.juceEligible && !songAudio.feedpakFullMix)) return;
        // Don't race window.highway.js's own initial song-load routing: it owns
        // _juceMode until _juceRoutingPromise settles. Re-running our switch
        // concurrently would double-call loadBackingTrack for the same URL.
        if (window._highwayJuceRoutingPending) return;

        // Claim the in-flight guard SYNCHRONOUSLY, before the first await. The
        // watcher is driven by a 350ms setInterval; if isAudioRunning() (or any
        // later await) stalls past the poll period, a second tick would
        // otherwise pass the `if (_rerouteInFlight) return` check above and run
        // a concurrent switch — duplicate loadBackingTrack IPCs racing on
        // _juceMode / audio.src. Setting it here closes that window.
        _rerouteInFlight = true;
        try {
            let running;
            try { running = await juceApi.isAudioRunning(); }
            catch (_) { return; }
            if (_isStale(songAudio)) return;               // song changed during IPC
            // Eligibility is evaluated per tick, not snapshotted at song load:
            // the output share mode can change mid-song (device switch in the
            // Audio Engine panel), and a feedpak full-mix must follow it —
            // exclusive → ride the engine; back to shared → return to HTML5.
            let eligible = !!songAudio.juceEligible;
            if (!eligible && songAudio.feedpakFullMix && running) {
                eligible = await _outputIsExclusive();
                if (_isStale(songAudio)) return;           // song changed during IPC
            }
            const wantJuce = !!(running && eligible);
            // [feedpak-route] diagnostics: one line per decision change (the
            // watcher polls at 350ms; steady state must not spam the buffer).
            const _decision = 'running=' + running + ' eligible=' + eligible
                + ' feedpakFullMix=' + !!songAudio.feedpakFullMix
                + ' juceMode=' + !!window._juceMode + ' url=' + songAudio.url;
            if (_decision !== window._lastFeedpakRouteDecision) {
                window._lastFeedpakRouteDecision = _decision;
                console.log('[feedpak-route] watcher:', _decision);
            }
            if (wantJuce === !!window._juceMode) return;   // routing already consistent
            // Don't keep retrying a track JUCE explicitly rejected.
            if (wantJuce && songAudio.url === _rerouteRejectedUrl) return;

            if (wantJuce) {
                const outcome = await _switchHtml5ToJuce(songAudio);
                // Memoise ONLY an explicit hard JUCE reject. A successful
                // switch clears the memo; a 'stale' abort (song changed
                // mid-flight) leaves it untouched — it must never be
                // misclassified as a reject, even if the song object was
                // swapped and then restored before this point.
                if (outcome === 'rejected') {
                    _rerouteRejectedUrl = songAudio.url;
                } else if (outcome === 'switched') {
                    _rerouteRejectedUrl = null;
                }
                // outcome === 'stale': leave _rerouteRejectedUrl as-is.
            } else {
                await _switchJuceToHtml5(songAudio);
                // The engine stopped (or a feedpak's output left exclusive
                // mode). Clear any hard-reject memo so a later engine restart
                // or mode change re-evaluates the track at least once — the
                // rejection may have been a transient device/decoder state.
                _rerouteRejectedUrl = null;
            }
        } catch (e) {
            // Transient failure — log but do NOT memoise, so the next poll retries.
            console.warn('[juce-reroute] re-route failed (will retry):', e);
        } finally {
            _rerouteInFlight = false;
        }
    }
    window._reevaluateJuceRouting = _reevaluateJuceRouting;

    // Clears the hard-reject memo. Called from the song-teardown sites that
    // null window._currentSongAudio (showScreen, playSong) so that reloading
    // the same file later gets a fresh routing attempt — a prior reject may
    // have been a transient JUCE/device state, not a permanent codec issue.
    window._clearJuceRerouteMemo = function () { _rerouteRejectedUrl = null; };

    // The engine can be started/stopped from several places (the desktop Audio
    // Engine panel, the audio_engine plugin, note_detect) and via setDevice
    // restarts — and the contextBridge api object is frozen, so its methods
    // can't be wrapped. Poll isAudioRunning() while a song is loaded; the check
    // is a cheap IPC boolean and no-ops once routing is already consistent.
    // Skip the poll while the document is hidden (background tab / minimised
    // window) — engine toggles there will be reconciled on the first poll
    // after the tab is visible again.
    setInterval(() => {
        if (document.hidden) return;
        if (window._currentSongAudio) void _reevaluateJuceRouting();
    }, 350);
})();

// Renderer-audio bus feeder (desktop Phase 2): when the engine holds the
// output endpoint in an exclusive-style mode, Chromium cannot reach the
// device, so any song audio still played by the renderer goes silent. The
// Phase 1 watcher above already migrates what a single-file transport can
// carry (loose /audio/ songs, feedpak full-mixes) onto the native backing
// transport. This feeder covers the rest — the stems plugin's multi-stem
// WebAudio graph, plus <audio>-element songs the native transport could not
// take (e.g. a codec loadBackingTrack rejected).
//
// Mechanism: capture the renderer-side master with an AudioWorklet tap,
// re-point the owning AudioContext at a null sink so it keeps rendering
// without a device, and push ~10 ms chunks over IPC into the engine's
// renderer bus, where they are mixed into the exclusive output like a
// backing track (~10-20 ms added latency on song audio only; the guitar
// monitoring path is untouched). Validated by the fix12 tester spike:
// null-sink rendering works, clocks hold (drift → 0), no overflow.
//
// Docker sphere: window.feedBackDesktop is undefined → this whole block is
// inert. Shared-mode desktop: the bus stays disabled (no double audio) and
// captured contexts keep/regain their default sink.
(function _installRendererBusFeeder() {
    const api = window.feedBackDesktop?.audio;
    if (!api || typeof api.setRendererBus !== 'function'
             || typeof api.pushRendererAudio !== 'function') {
        // Silent in the Docker sphere (no bridge, no debug flag); a desktop
        // bridge missing the bus API is the diagnostic case.
        if (window.feedBackDesktop) {
            console.log('[asio-diag] renderer-bus feeder NOT installed (api=' + !!api
                + ' setRendererBus=' + typeof api?.setRendererBus
                + ' pushRendererAudio=' + typeof api?.pushRendererAudio + ')');
        }
        return;
    }
    // Deferred like the watcher's install line: gate on the async debug flag.
    if (typeof api.debugEnabled === 'function') {
        api.debugEnabled().then((v) => {
            if (v) console.log('[asio-diag] renderer-bus feeder installed (loopback-capable='
                + (typeof window.navigator?.mediaDevices?.getDisplayMedia === 'function') + ')');
        }).catch(() => {});
    }

    const TAP_WORKLET = `
        class FeedbackBusTap extends AudioWorkletProcessor {
            process(inputs) {
                const inp = inputs[0];
                if (inp && inp[0]) {
                    const L = inp[0], R = inp[1] || inp[0];
                    const out = new Float32Array(L.length * 2);
                    for (let i = 0; i < L.length; i++) { out[i*2] = L[i]; out[i*2+1] = R[i]; }
                    this.port.postMessage(out, [out.buffer]);
                }
                return true;
            }
        }
        registerProcessor('feedback-bus-tap', FeedbackBusTap);
    `;
    const _tapModuleUrl = URL.createObjectURL(new Blob([TAP_WORKLET], { type: 'application/javascript' }));
    const _tapModuleLoaded = new WeakSet();   // AudioContexts with the module added

    // One tap per captured graph. `active` gates the push (the worklet keeps
    // running when inactive — it's silent bookkeeping, not audio).
    function _makeTap(ctx) {
        const state = { node: null, active: false, batch: [], batchFrames: 0 };
        state.attach = async (sourceNode) => {
            if (!_tapModuleLoaded.has(ctx)) {
                await ctx.audioWorklet.addModule(_tapModuleUrl);
                _tapModuleLoaded.add(ctx);
            }
            if (!state.node) {
                state.node = new AudioWorkletNode(ctx, 'feedback-bus-tap', { numberOfInputs: 1, channelCount: 2 });
                const BATCH = Math.round(ctx.sampleRate / 100);   // ~10 ms
                state.node.port.onmessage = (e) => {
                    if (!state.active) { state.batch = []; state.batchFrames = 0; return; }
                    state.batch.push(e.data);
                    state.batchFrames += e.data.length / 2;
                    if (state.batchFrames >= BATCH) {
                        const merged = new Float32Array(state.batchFrames * 2);
                        let o = 0;
                        for (const c of state.batch) { merged.set(c, o); o += c.length; }
                        api.pushRendererAudio(merged, ctx.sampleRate);
                        state.batch = []; state.batchFrames = 0;
                    }
                };
            }
            sourceNode.connect(state.node);
            // No onward connection: the tap is a sink-side observer; audibility
            // in shared mode comes from the graph's own destination path.
        };
        state.detach = (sourceNode) => {
            state.active = false;
            state.batch = []; state.batchFrames = 0;
            if (state.node && sourceNode) {
                try { sourceNode.disconnect(state.node); } catch (_) { /* already gone */ }
            }
        };
        return state;
    }

    // ── Core <audio> element capture ─────────────────────────────────────────
    // createMediaElementSource permanently reroutes the element into its
    // context, so it is created lazily — only the first time an exclusive
    // device actually needs it — and never torn down. From then on the element
    // always plays through _elCtx; sink toggling routes it to the speakers
    // (shared mode) or the null sink + bus (exclusive mode).
    let _elCtx = null, _elSource = null, _elTap = null;
    async function _ensureElementCapture() {
        if (_elCtx) return;
        const el = document.getElementById('audio');
        if (!el) throw new Error('no core audio element');
        // Assign the module state ONLY after the whole chain succeeded.
        // createMediaElementSource throws InvalidStateError when another
        // consumer (highway_3d's analyser tap) already owns the element's
        // one-shot source — assigning _elCtx before that throw poisoned every
        // later tick into `_elTap.active` TypeErrors (tester log 2026-07-11)
        // while the song kept playing on the default device.
        const ctx = new AudioContext();
        let source, tap;
        try {
            source = ctx.createMediaElementSource(el);
            source.connect(ctx.destination);
            tap = _makeTap(ctx);
            await tap.attach(source);
        } catch (e) {
            try { await ctx.close(); } catch (_) { /* already closed */ }
            throw e;
        }
        _elCtx = ctx; _elSource = source; _elTap = tap;
    }

    // ── Whole-app loopback capture ───────────────────────────────────────────
    // Preferred mode: one getDisplayMedia frame-audio capture covers EVERY
    // sound the app makes (song, previews, UI) — no per-surface taps, so
    // plugin-private AudioContexts (song-preview, future plugins) survive
    // exclusive/ASIO output too. The desktop main process answers the request
    // with this window's own frame (frame-scoped — no other apps' audio).
    // Local playback is silenced via the suppressLocalAudioPlayback track
    // constraint, with a page-mute IPC fallback (capture taps frame audio
    // before the output mute, so a muted page still feeds the stream).
    let _lbStream = null, _lbCtx = null, _lbTap = null, _lbPageMuted = false;
    let _loopbackUnavailable = false;   // sticky: probe once, then fall back
    async function _engageLoopback() {
        // Chromium's default capture pipeline treats the audio track as a
        // VOICE call: echo cancellation + noise suppression + AGC + mono
        // downmix. On music that is the "tin can" sound (tester 2026-07-12).
        // Request the raw stereo path explicitly — every constraint here is
        // best-effort (ideal-valued), so unsupported ones degrade silently
        // rather than failing the capture.
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: {
                suppressLocalAudioPlayback: true,
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                channelCount: 2,
                sampleRate: 48000,
            },
        });
        for (const t of stream.getVideoTracks()) t.stop();   // required, unused
        const track = stream.getAudioTracks()[0];
        if (!track) {
            for (const t of stream.getTracks()) t.stop();
            throw new Error('no loopback audio track');
        }
        try {
            // Fresh context per session (not reused) so teardown's close()
            // fully releases the tap worklet node — see _teardownLoopback.
            _lbCtx = new AudioContext();
            if (_lbCtx.state !== 'running') await _lbCtx.resume().catch(() => {});
            const source = _lbCtx.createMediaStreamSource(stream);
            const tap = _makeTap(_lbCtx);
            await tap.attach(source);
            const suppressed = track.getSettings?.().suppressLocalAudioPlayback === true;
            if (!suppressed && typeof api.setPageMuted === 'function') {
                _lbPageMuted = (await api.setPageMuted(true)) === true;
            }
            if (window._asioDiagEnabled?.()) {
                // Full track settings: shows whether the raw-audio constraints
                // (no EC/NS/AGC, stereo) actually took — a track that still
                // reports echoCancellation=true or channelCount=1 explains
                // "tin can" quality reports directly from the log.
                const s = track.getSettings?.() || {};
                console.log('[asio-diag] loopback: suppressed=', suppressed,
                    'pageMuted=', _lbPageMuted, 'rate=', _lbCtx.sampleRate,
                    'track=', JSON.stringify({
                        sampleRate: s.sampleRate, channelCount: s.channelCount,
                        echoCancellation: s.echoCancellation,
                        noiseSuppression: s.noiseSuppression,
                        autoGainControl: s.autoGainControl,
                    }));
            }
            await api.setRendererBus(true, 1.0);
            tap.active = true;
            _lbStream = stream; _lbTap = tap;
            _mode = 'loopback';
            console.log('[renderer-bus] engaged: app loopback → engine bus');
        } catch (e) {
            for (const t of stream.getTracks()) t.stop();
            throw e;
        }
    }
    async function _teardownLoopback() {
        if (_lbTap) _lbTap.active = false;
        if (_lbStream) for (const t of _lbStream.getTracks()) t.stop();
        _lbStream = null; _lbTap = null;
        // Close the capture context so its tap worklet node is released. The
        // context is per-session (not reused): without this, each exclusive⇄
        // shared switch orphaned a live worklet on a long-lived context.
        if (_lbCtx) {
            try { await _lbCtx.close(); } catch (_) { /* already closed */ }
            _lbCtx = null;
        }
        if (_lbPageMuted && typeof api.setPageMuted === 'function') {
            try { await api.setPageMuted(false); } catch (_) { /* engine gone */ }
        }
        _lbPageMuted = false;
    }

    // ── Engagement state machine ─────────────────────────────────────────────
    // 'off' | 'loopback' | 'element' | 'stems' (element/stems = fallback when
    // loopback capture is unavailable: old desktop main, denied capture)
    let _mode = 'off';
    let _stemsGraph = null;   // { context, masterNode } snapshot while engaged
    let _stemsTap = null;
    const _stemsTaps = new WeakMap();  // context → tap (stems ctx is reused across songs)
    let _busy = false;

    async function _setSink(ctx, exclusive) {
        if (typeof ctx.setSinkId !== 'function') throw new Error('setSinkId unsupported');
        await ctx.setSinkId(exclusive ? { type: 'none' } : '');
        if (ctx.state !== 'running') await ctx.resume().catch(() => {});
        // [asio-diag] a context left on the default sink while the bus is
        // engaged is exactly the "song on the wrong device" symptom — record
        // every successful sink flip (failures throw and are logged upstream).
        if (window._asioDiagEnabled?.()) {
            console.log('[asio-diag] setSink:', exclusive ? 'null-sink' : 'default',
                'state=', ctx.state, 'rate=', ctx.sampleRate);
        }
    }

    async function _disengage() {
        if (_mode === 'off') return;
        const prev = _mode;
        _mode = 'off';
        try { await api.setRendererBus(false, 0); } catch (_) { /* engine gone */ }
        if (prev === 'loopback') {
            await _teardownLoopback();
        } else if (prev === 'element' && _elCtx) {
            _elTap.active = false;
            await _setSink(_elCtx, false).catch(() => {});
        } else if (prev === 'stems' && _stemsGraph) {
            if (_stemsTap) _stemsTap.detach(_stemsGraph.masterNode);
            await _setSink(_stemsGraph.context, false).catch(() => {});
            _stemsGraph = null; _stemsTap = null;
        }
        console.log('[renderer-bus] disengaged (' + prev + ')');
    }

    async function _engageStems(graph) {
        await _setSink(graph.context, true);
        let tap = _stemsTaps.get(graph.context);
        if (!tap) { tap = _makeTap(graph.context); _stemsTaps.set(graph.context, tap); }
        await tap.attach(graph.masterNode);
        await api.setRendererBus(true, 1.0);
        tap.active = true;
        _stemsGraph = graph; _stemsTap = tap;
        _mode = 'stems';
        console.log('[renderer-bus] engaged: stems graph → engine bus');
    }

    async function _engageElement() {
        await _ensureElementCapture();
        await _setSink(_elCtx, true);
        await api.setRendererBus(true, 1.0);
        _elTap.active = true;
        _mode = 'element';
        console.log('[renderer-bus] engaged: <audio> element → engine bus');
    }

    async function _reevaluate() {
        if (_busy) return;
        _busy = true;
        try {
            let running = false, exclusive = false;
            try {
                running = await api.isAudioRunning();
            } catch (_) { /* engine unreachable → treat as not running */ }
            if (running) {
                // Reuse the Phase 1 predicate installed by the routing watcher
                // (getCurrentDevice + exclusive-type check with change-logged
                // diagnostics). Fail closed if it is somehow absent.
                exclusive = !!(await window._juceOutputIsExclusive?.());
            }

            // The stems plugin publishes its live graph while a multi-stem
            // song is loaded (and removes it on teardown).
            const stems = (window.feedBack || window.slopsmith)?.stems?.audioGraph || null;
            // Element songs: a song is loaded, it is NOT riding the native
            // transport (Phase 1 owns those), and the stems graph is not the
            // player. Covers native-transport rejects (codec) in exclusive
            // mode — without this they would be silent.
            const songAudio = window._currentSongAudio;
            const elementSong = !!songAudio && !window._juceMode && !stems;

            let want = 'off';
            if (running && exclusive) {
                // Loopback covers ALL app audio (song, previews, UI), so it
                // engages for the whole exclusive session — not just while a
                // song is loaded. Per-surface modes remain as fallback when
                // loopback capture is unavailable (old desktop main without
                // the display-media handler, capture denied).
                if (!_loopbackUnavailable) want = 'loopback';
                else if (stems) want = 'stems';
                else if (elementSong) want = 'element';
            }
            // Song audio riding the native transport must not ALSO ride the
            // loopback (double-carry into the same engine output). The native
            // transport plays from the engine, not the page, so page loopback
            // never hears it — no conflict; loopback stays engaged for
            // previews/UI while the transport owns the song.

            // [asio-diag] full decision vector, change-gated (500ms poll —
            // steady state must not flood the buffer). This is the feeder-side
            // counterpart of the watcher's [feedpak-route] decision line: it
            // shows WHY the bus did or didn't engage (exclusive predicate,
            // stems graph presence, native transport ownership, element song).
            if (window._asioDiagEnabled?.()) {
                const d = 'running=' + running + ' exclusive=' + exclusive
                    + ' stems=' + !!stems + ' songAudio=' + !!songAudio
                    + ' juceMode=' + !!window._juceMode
                    + ' elementSong=' + elementSong
                    + ' loopbackUnavailable=' + _loopbackUnavailable
                    + ' want=' + want + ' mode=' + _mode;
                if (d !== window._lastRendererBusDecision) {
                    window._lastRendererBusDecision = d;
                    console.log('[asio-diag] renderer-bus:', d);
                }
            }


            const stemsGraphChanged = _mode === 'stems' && stems !== _stemsGraph;
            if (want !== _mode || stemsGraphChanged) {
                await _disengage();
                try {
                    if (want === 'loopback') await _engageLoopback();
                    else if (want === 'stems') await _engageStems(stems);
                    else if (want === 'element') await _engageElement();
                } catch (e) {
                    if (want === 'loopback') {
                        // Capture unavailable (no handler in an old desktop
                        // main, permission denied) — remember and fall back to
                        // the per-surface modes on the next tick.
                        _loopbackUnavailable = true;
                        console.warn('[renderer-bus] loopback capture unavailable — falling back to surface taps:', e);
                    }
                    throw e;
                }
            }
        } catch (e) {
            // Explicit name/message/stack head — the console-message forward
            // stringifies a DOMException to the useless "[object DOMException]".
            console.warn('[renderer-bus] reevaluate failed (will retry):',
                (e && e.name ? e.name + ': ' + e.message : String(e)),
                (e && e.stack ? '| ' + String(e.stack).split('\n')[1] : ''));
            _mode = 'off';
            // A partial engage may have left the bus enabled with no producer
            // and the page muted — undo both so a failed tick can't strand
            // audio in silence until the next successful engage.
            try { await api.setRendererBus(false, 0); } catch (_) { /* engine gone */ }
            await _teardownLoopback().catch(() => {});
        } finally {
            _busy = false;
        }
    }

    // Same cadence/rationale as the routing watcher above. Also re-check on
    // visibility return so a device switch made while hidden is reconciled.
    setInterval(() => { if (!document.hidden) void _reevaluate(); }, 500);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void _reevaluate(); });
    window._reevaluateRendererBus = _reevaluate;
})();

// Desktop JUCE backing uses an empty <audio> element; plugins such as Section Map
// still seek via audio.currentTime / pause / play. Mirror those onto jucePlayer
// while _juceMode is active. Same-tick pause+seek coalesce into a single seek
// (no stopBacking before seek — HTML5 needed that for buffering; JUCE does not).
export let _resetJuceAudioShimChain = function () {};
(function _installJuceAudioElementShim() {
    if (!window.feedBackDesktop?.audio) return;

    const mediaProto = HTMLMediaElement.prototype;
    const ctDesc = Object.getOwnPropertyDescriptor(mediaProto, 'currentTime');
    const pausedDesc = Object.getOwnPropertyDescriptor(mediaProto, 'paused');
    if (!ctDesc?.get || !ctDesc?.set || !pausedDesc?.get) return;

    const nativePlay = mediaProto.play;
    const nativePause = mediaProto.pause;

    let chain = Promise.resolve();
    /** Same-tick pause + seek (Section Map): coalesce to one seek — no stopBacking before seek. */
    let _juceShimBatch = null;
    let _juceShimBatchFlushScheduled = false;
    let _juceShimGen = 0;
    function enqueue(fn) {
        const gen = _juceShimGen;
        const p = chain.then(async () => {
            if (gen !== _juceShimGen) return;
            return fn(gen);
        });
        chain = p.catch((e) => {
            console.warn('[juce-audio-shim]', e);
        });
        return p;
    }
    // forUpcomingPlay: caller will enqueue a play() right after, so don't
    // emit pause-state side effects for a wantsPause batch — play() will
    // overwrite them anyway.
    function flushJuceShimBatchNow({ forUpcomingPlay = false } = {}) {
        _juceShimBatchFlushScheduled = false;
        const batch = _juceShimBatch;
        _juceShimBatch = null;
        if (!batch || !window._juceMode) return;
        const wantsPause = !!batch.wantsPause;
        const seekTime = batch.seekTime;
        if (wantsPause && seekTime !== undefined) {
            enqueue(async (gen) => {
                const r = await _audioSeek(seekTime, 'audio-element-shim');
                if (!r.completed) return; // seek cancelled by teardown
                if (gen !== _juceShimGen) return;
                if (!forUpcomingPlay) {
                    await jucePlayer.pause();
                    if (gen !== _juceShimGen) return;
                    S.isPlaying = false;
                    setPlayButtonState(false);
                    const sm = window.feedBack;
                    if (sm) {
                        sm.isPlaying = false;
                        sm.emit('song:pause', _songEventPayload());
                    }
                }
                audio.dispatchEvent(new Event('seeked'));
            });
            return;
        }
        if (wantsPause) {
            enqueue(async (gen) => {
                await jucePlayer.pause();
                if (gen !== _juceShimGen) return;
                S.isPlaying = false;
                setPlayButtonState(false);
                const sm = window.feedBack;
                if (sm) {
                    sm.isPlaying = false;
                    sm.emit('song:pause', _songEventPayload());
                }
            });
            return;
        }
        if (seekTime !== undefined) {
            enqueue(async (gen) => {
                const r = await _audioSeek(seekTime, 'audio-element-shim');
                if (!r.completed) return; // seek cancelled by teardown
                if (gen !== _juceShimGen) return;
                audio.dispatchEvent(new Event('seeked'));
            });
        }
    }
    function scheduleJuceShimBatchFlush() {
        if (_juceShimBatchFlushScheduled) return;
        _juceShimBatchFlushScheduled = true;
        const flushGen = _juceShimGen;
        queueMicrotask(() => {
            if (flushGen !== _juceShimGen) {
                _juceShimBatchFlushScheduled = false;
                return;
            }
            flushJuceShimBatchNow();
        });
    }
    _resetJuceAudioShimChain = function () {
        chain = Promise.resolve();
        _juceShimBatch = null;
        _juceShimBatchFlushScheduled = false;
        _juceShimGen++;
    };

    Object.defineProperty(audio, 'currentTime', {
        get() {
            if (window._juceMode) return jucePlayer.currentTime;
            return ctDesc.get.call(this);
        },
        set(v) {
            if (window._juceMode) {
                const t = Math.max(0, Number(v) || 0);
                _juceShimBatch = _juceShimBatch || {};
                _juceShimBatch.seekTime = t;
                scheduleJuceShimBatchFlush();
                return;
            }
            ctDesc.set.call(this, v);
        },
        configurable: true,
    });

    Object.defineProperty(audio, 'paused', {
        get() {
            if (window._juceMode) return !S.isPlaying;
            return pausedDesc.get.call(this);
        },
        configurable: true,
    });

    audio.pause = function () {
        if (window._juceMode) {
            _juceShimBatch = _juceShimBatch || {};
            _juceShimBatch.wantsPause = true;
            scheduleJuceShimBatchFlush();
            return;
        }
        nativePause.call(audio);
    };

    audio.play = function () {
        if (window._juceMode) {
            if (_juceShimBatch != null) flushJuceShimBatchNow({ forUpcomingPlay: true });
            const p = enqueue(async (gen) => {
                const started = await jucePlayer.play();
                if (gen !== _juceShimGen || !started) return;
                S.isPlaying = true;
                setPlayButtonState(true);
                const sm = window.feedBack;
                if (sm) {
                    sm.isPlaying = true;
                    const payload = _songEventPayload();
                    sm.emit('song:play', payload);
                    sm.emit('song:resume', payload);
                }
            });
            return p.then(() => undefined);
        }
        return nativePlay.call(audio);
    };
})();
