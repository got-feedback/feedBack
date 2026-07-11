/*
 * fee[dB]ack — Venue crowd video layer (career mode PR1).
 *
 * Crossfades pre-rendered crowd-state loop videos behind the highway based on
 * v3:live-performance-state, plus one-shot reaction stingers. Renders through
 * two video backdrop planes owned by the highway_3d venue background style
 * (window.h3dVenueBackdropSetVideo / window.h3dVenueBackdropSetMix).
 *
 * Inert unless a venue pack manifest is set — by the career plugin via
 * v3VenueCrowd.setManifest(), or (dev only) a JSON manifest in localStorage
 * under feedBack-venue-crowd-dev. With no manifest the static bg plate
 * behaves exactly as before.
 */
(function (root) {
    'use strict';

    // live-performance-hud state → crowd state.
    const CROWD_OF_PERF = {
        smoke: 'bored',
        recovery: 'bored',
        idle: 'neutral',
        steady: 'neutral',
        strong: 'engaged',
        fire: 'ecstatic',
    };
    const CROWD_STATES = ['bored', 'neutral', 'engaged', 'ecstatic'];
    const CROWD_RANK = { bored: 0, neutral: 1, engaged: 2, ecstatic: 3 };

    const STABLE_MS = 3000;        // target must hold this long before a switch
    const DWELL_MS = 8000;         // min time between committed switches
    const FADE_MS = 1200;          // loop crossfade
    const STINGER_FADE_MS = 400;   // stinger fade-in/out
    const STINGER_MIN_GAP_MS = 20000;
    const STREAK_MILESTONES = [25, 50, 100];
    const CANPLAY_TIMEOUT_MS = 4000;
    const DEV_FLAG_KEY = 'feedBack-venue-crowd-dev';

    // ---------------------------------------------------------------------
    // Pure, clock-injected decision logic (unit-tested in
    // tests/js/venue_crowd.test.js — keep DOM-free).
    // ---------------------------------------------------------------------

    function crowdStateOfPerf(perfState) {
        return CROWD_OF_PERF[String(perfState || '').toLowerCase()] || 'neutral';
    }

    // Hysteresis: a new target must be observed continuously for STABLE_MS,
    // and at least DWELL_MS must have passed since the last committed switch.
    function createCrowdMachine() {
        let current = 'neutral';
        let candidate = null;
        let candidateSince = 0;
        let lastSwitchAt = -Infinity;
        return {
            get current() { return current; },
            // Feed the latest perf state; returns the new crowd state when a
            // transition commits, else null.
            update(perfState, nowMs) {
                const target = crowdStateOfPerf(perfState);
                if (target === current) {
                    candidate = null;
                    return null;
                }
                if (target !== candidate) {
                    candidate = target;
                    candidateSince = nowMs;
                    return null;
                }
                if (nowMs - candidateSince < STABLE_MS) return null;
                if (nowMs - lastSwitchAt < DWELL_MS) return null;
                current = target;
                candidate = null;
                lastSwitchAt = nowMs;
                return current;
            },
        };
    }

    // Cheer when the streak crosses a milestone (rising edge only).
    function stingerForStreak(prevStreak, streak) {
        for (const m of STREAK_MILESTONES) {
            if (prevStreak < m && streak >= m) return 'cheer';
        }
        return null;
    }

    // End-of-song reaction from final accuracy.
    function stingerForAccuracy(accuracyPct) {
        const a = Number(accuracyPct);
        if (!Number.isFinite(a)) return null;
        if (a >= 90) return 'cheer';
        if (a >= 75) return 'clap';
        return null;
    }

    // ---------------------------------------------------------------------
    // Video layer controller (browser only).
    // ---------------------------------------------------------------------

    const machine = createCrowdMachine();
    let _manifest = null;       // { loops: {state: url}, stingers: {name: url} }
    let _venueActive = false;
    let _videos = [null, null];
    let _activeLayer = 0;       // layer currently showing the loop
    let _mix = 0;               // 0 → layer0 visible, 1 → layer1 visible
    let _fadeRaf = 0;
    let _stopGen = 0;           // bumped by stop(): invalidates ALL in-flight loads
    let _boundToRenderer = false;
    let _pendingLoop = null;    // loop switch deferred by an active stinger
    let _loadingLoop = null;    // loop currently waiting on canplaythrough
    let _fadingLoop = null;     // loop currently crossfading in (not yet active)
    let _stingerUntilEnded = false;
    let _lastStingerAt = -Infinity;
    let _prevStreak = 0;
    let _lastAccuracyPct = null; // from perf events; stats:recorded carries none
    let _bound = false;

    function now() { return Date.now(); }

    function h3d(name) {
        return root && typeof root[name] === 'function' ? root[name] : null;
    }

    function normalizeManifest(m) {
        if (!m || typeof m !== 'object' || !m.loops) return null;
        const base = typeof m.base === 'string' ? m.base : '';
        const abs = (u) => (typeof u === 'string' && u ? base + u : '');
        const loops = {};
        for (const s of CROWD_STATES) loops[s] = abs(m.loops[s]);
        if (!CROWD_STATES.every((s) => loops[s])) return null;
        const stingers = {};
        for (const k of ['clap', 'cheer']) stingers[k] = abs(m.stingers && m.stingers[k]);
        return { loops, stingers };
    }

    function ensureVideos() {
        if (!_videos[0] && typeof document !== 'undefined') {
            for (let i = 0; i < 2; i++) {
                const v = document.createElement('video');
                // Same autoplay-safe recipe as the highway_3d video bg style:
                // muted + playsInline bypasses gesture requirements; same-origin
                // URLs so VideoTexture never taints.
                v.muted = true;
                v.playsInline = true;
                v.preload = 'auto';
                v.loop = true;
                v.style.display = 'none';
                document.body.appendChild(v);
                _videos[i] = v;
            }
        }
        bindVideosToRenderer();
    }

    // The highway_3d plugin (and its globals) can register after the venue
    // pack starts — e.g. Venue selected at page load, renderer ready later.
    // Idempotent and retried from start() and the perf-event path so a late
    // renderer still picks the videos up.
    function bindVideosToRenderer() {
        if (_boundToRenderer || !_videos[0]) return;
        const setVideo = h3d('h3dVenueBackdropSetVideo');
        if (!setVideo) return;
        setVideo(0, _videos[0]);
        setVideo(1, _videos[1]);
        _boundToRenderer = true;
        setMix(_mix); // re-push mix the renderer missed while unregistered
    }

    function setMix(v) {
        _mix = Math.max(0, Math.min(1, v));
        const fn = h3d('h3dVenueBackdropSetMix');
        if (fn) fn(_mix);
    }

    function cancelFade() {
        if (_fadeRaf && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(_fadeRaf);
        }
        _fadeRaf = 0;
    }

    function fadeMixTo(target, durationMs, done) {
        cancelFade();
        if (typeof requestAnimationFrame !== 'function') {
            setMix(target);
            if (done) done();
            return;
        }
        const from = _mix;
        const t0 = now();
        const step = () => {
            const k = Math.min(1, (now() - t0) / durationMs);
            setMix(from + (target - from) * k);
            if (k < 1) {
                _fadeRaf = requestAnimationFrame(step);
            } else {
                _fadeRaf = 0;
                if (done) done();
            }
        };
        _fadeRaf = requestAnimationFrame(step);
    }

    // Load url into the video, resolve when it can play through (or after a
    // timeout — a stalled fetch must not wedge the crowd forever). Tokens are
    // per-element: a later load on the SAME video (a stinger preempting the
    // idle layer) cancels this one, but loads on the other layer don't.
    function loadAndPlay(video, url, loop, cb) {
        const token = (video._fbCrowdToken = (video._fbCrowdToken || 0) + 1);
        const gen = _stopGen;
        let settled = false;
        const settle = (ok) => {
            if (settled || token !== video._fbCrowdToken || gen !== _stopGen) return;
            settled = true;
            video.removeEventListener('canplaythrough', onReady);
            video.removeEventListener('error', onError);
            cb(ok);
        };
        const onReady = () => settle(true);
        const onError = () => settle(false);
        video.addEventListener('canplaythrough', onReady);
        video.addEventListener('error', onError);
        video.loop = loop;
        video.src = url;
        video.play().catch(() => { /* browser retries on visibility/gesture */ });
        setTimeout(() => settle(video.readyState >= 3), CANPLAY_TIMEOUT_MS);
    }

    function idleLayer() { return _activeLayer === 0 ? 1 : 0; }

    // Crossfade the loop for `state` in on the idle layer.
    function showLoop(state, fadeMs) {
        if (!_manifest || !_videos[0]) return;
        const layer = idleLayer();
        const video = _videos[layer];
        _loadingLoop = state;
        loadAndPlay(video, _manifest.loops[state], true, (ok) => {
            if (_loadingLoop === state) _loadingLoop = null;
            if (!ok || !_venueActive) return;
            _fadingLoop = state;
            fadeMixTo(layer === 1 ? 1 : 0, fadeMs, () => {
                if (_fadingLoop === state) _fadingLoop = null;
                const old = _videos[_activeLayer];
                _activeLayer = layer;
                if (old && !old.paused) old.pause();
            });
        });
    }

    function playStinger(name) {
        if (!_manifest || !_manifest.stingers[name] || !_videos[0]) return;
        if (_stingerUntilEnded) return;
        const t = now();
        if (t - _lastStingerAt < STINGER_MIN_GAP_MS) return;
        _lastStingerAt = t;
        _stingerUntilEnded = true;
        const layer = idleLayer();
        const video = _videos[layer];
        // The stinger reuses the idle layer's element, cancelling any loop
        // load still in flight there — and idleLayer() is still the fading-in
        // layer while a crossfade runs (_activeLayer flips on completion), so
        // a mid-fade loop gets overwritten too. Requeue either for when the
        // stinger ends (the machine already advanced, nothing re-fires it).
        const interrupted = _loadingLoop || _fadingLoop;
        if (interrupted) {
            _pendingLoop = interrupted;
            _loadingLoop = null;
            _fadingLoop = null;
        }
        // A loop switch deferred (or preempted) by this stinger must play
        // once the stinger is done OR failed — the machine already advanced,
        // so nothing re-triggers it later.
        const flushPending = () => {
            if (!_pendingLoop || !_venueActive) return;
            const pending = _pendingLoop;
            _pendingLoop = null;
            showLoop(pending, FADE_MS);
        };
        const back = () => {
            if (!_stingerUntilEnded) return;
            _stingerUntilEnded = false;
            video.removeEventListener('ended', back);
            // Fade back to the loop layer (which kept playing underneath).
            fadeMixTo(_activeLayer === 1 ? 1 : 0, STINGER_FADE_MS);
            flushPending();
        };
        loadAndPlay(video, _manifest.stingers[name], false, (ok) => {
            if (!ok || !_venueActive) {
                _stingerUntilEnded = false;
                flushPending();
                return;
            }
            video.addEventListener('ended', back);
            fadeMixTo(layer === 1 ? 1 : 0, STINGER_FADE_MS);
            // Safety: an `ended` that never fires (decode stall) must not
            // freeze the crowd on a stinger frame.
            setTimeout(back, 15000);
        });
    }

    function onPerformanceState(e) {
        if (!_venueActive || !_manifest) return;
        bindVideosToRenderer();
        const d = (e && e.detail) || {};
        if (Number.isFinite(Number(d.accuracyPct))) _lastAccuracyPct = Number(d.accuracyPct);
        const streak = Number(d.streak) || 0;
        const sting = stingerForStreak(_prevStreak, streak);
        _prevStreak = streak;
        if (sting && CROWD_RANK[machine.current] >= CROWD_RANK.neutral) {
            playStinger(sting);
        }
        const next = machine.update(d.state, now());
        if (next) {
            // A stinger owns the idle layer; defer the switch until it ends.
            if (_stingerUntilEnded) _pendingLoop = next;
            else showLoop(next, FADE_MS);
        }
    }

    function onStatsRecorded() {
        if (!_venueActive || !_manifest) return;
        // stats:recorded carries only {filename, arrangement} — the accuracy
        // comes from the last v3:live-performance-state of the finished song.
        const sting = stingerForAccuracy(_lastAccuracyPct);
        _lastAccuracyPct = null; // one reaction per song
        if (sting) {
            _lastStingerAt = -Infinity; // end-of-song reaction always allowed
            playStinger(sting);
        }
    }

    function start() {
        ensureVideos();
        if (!_videos[0]) return;
        _prevStreak = 0;
        // Boot straight into the current machine state on the active layer.
        const video = _videos[_activeLayer];
        loadAndPlay(video, _manifest.loops[machine.current], true, (ok) => {
            if (!ok || !_venueActive) return;
            setMix(_activeLayer === 1 ? 1 : 0);
        });
    }

    function stop() {
        cancelFade();
        _stopGen++;
        _stingerUntilEnded = false;
        _pendingLoop = null;
        _loadingLoop = null;
        _fadingLoop = null;
        for (const v of _videos) {
            if (v && !v.paused) v.pause();
        }
        // Unbind from the renderer: a paused video still holds its last
        // frame, and the venue style keeps a bound plane visible whenever
        // videoWidth > 0 — without this a removed pack would leave a frozen
        // crowd frame over the static plate. start() re-binds.
        const setVideo = h3d('h3dVenueBackdropSetVideo');
        if (_boundToRenderer && setVideo) {
            setVideo(0, null);
            setVideo(1, null);
        }
        _boundToRenderer = false;
        setMix(0);
    }

    function setVenueActive(on) {
        const next = !!on;
        if (next === _venueActive) {
            // Re-activation (e.g. viz:renderer:ready after a late plugin
            // load): don't restart the loop, but do retry renderer binding.
            if (next && _manifest) bindVideosToRenderer();
            return;
        }
        _venueActive = next;
        if (_venueActive && _manifest) start();
        else stop();
    }

    function setManifest(m) {
        const norm = normalizeManifest(m);
        _manifest = norm;
        if (_venueActive) {
            // Full stop first even when replacing pack-for-pack: it bumps
            // _stopGen so an in-flight load from the OLD manifest can't
            // settle and fade a stale URL in after the new pack starts.
            stop();
            if (norm) start();
        }
    }

    function readDevManifest() {
        try {
            const raw = localStorage.getItem(DEV_FLAG_KEY);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (_) {
            return null;
        }
    }

    function bindRuntime() {
        if (_bound) return;
        _bound = true;
        const sm = root && root.feedBack;
        if (sm && typeof sm.on === 'function') {
            sm.on('v3:live-performance-state', onPerformanceState);
            sm.on('stats:recorded', onStatsRecorded);
        }
        const dev = readDevManifest();
        if (dev && !_manifest) setManifest(dev);
    }

    function getState() {
        return {
            venueActive: _venueActive,
            hasManifest: !!_manifest,
            crowdState: machine.current,
            activeLayer: _activeLayer,
            mix: _mix,
            stingerActive: _stingerUntilEnded,
        };
    }

    const api = {
        CROWD_STATES,
        STABLE_MS,
        DWELL_MS,
        crowdStateOfPerf,
        createCrowdMachine,
        stingerForStreak,
        stingerForAccuracy,
        normalizeManifest,
        setManifest,
        setVenueActive,
        bindRuntime,
        getState,
    };

    if (root) root.v3VenueCrowd = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;

    if (typeof document !== 'undefined') {
        // Same defer/DOMContentLoaded dance as venue-scene-3d.js.
        if (document.readyState !== 'complete') {
            document.addEventListener('DOMContentLoaded', bindRuntime);
        } else {
            bindRuntime();
        }
    }
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null)));
