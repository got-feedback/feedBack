// feedBack-plugin-minigames — SDK + hub controller.
//
// This file does two things:
//   1) Publishes window.feedBackMinigames — the SDK that individual
//      minigame plugins call (register, start/end, scoring, ui, persistence).
//   2) Mounts a hub UI in screen.html that lists every registered minigame
//      and the shared profile/leaderboards.
//
// Plugin load order is alphabetical, so minigame plugins (e.g. flappy_bend)
// load BEFORE this script. They should register via a tiny shim that queues
// to `window.__feedBackMinigamesPending` if the SDK isn't up yet — we drain
// the queue on init and also fire `feedBack-minigames-ready` once ready.

(function () {
  'use strict';

  if (window.feedBackMinigames && window.feedBackMinigames.__alive) {
    return; // hot-reload guard
  }

  const PLUGIN_ID = 'minigames';
  const API_BASE  = `/api/plugins/${PLUGIN_ID}`;

  // ── YIN pitch tracker ─────────────────────────────────────────────────
  // Compact YIN (de Cheveigné & Kawahara, 2002). Sufficient for monophonic
  // electric-guitar pitch tracking down to ~80 Hz. Returns:
  //   { freqHz, confidence }   — confidence in [0, 1]
  // or null if no confident pitch was found in the buffer.
  // scratchD / scratchCmnd are optional preallocated Float32Arrays of length
  // ≥ halfN. Pass them from the createContinuous closure to avoid per-callback
  // allocations. If omitted, yinDetect allocates its own (slower but safe).
  function yinDetect(buf, sampleRate, opts, scratchD, scratchCmnd) {
    const threshold = (opts && opts.threshold) || 0.15;
    const minHz     = (opts && opts.minHz)     || 70;
    const maxHz     = (opts && opts.maxHz)     || 1500;
    const N         = buf.length;
    const halfN     = (N / 2) | 0;
    const tauMin    = Math.max(2, Math.floor(sampleRate / maxHz));
    const tauMax    = Math.min(halfN - 1, Math.floor(sampleRate / minHz));

    // Difference function d(τ). Only compute up to tauMax — values beyond
    // tauMax can never be selected, so computing them is wasteful O(N^2) work.
    // Reuse scratch buffer if provided.
    const d = (scratchD && scratchD.length >= halfN) ? scratchD : new Float32Array(halfN);
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let i = 0; i < halfN; i++) {
        const diff = buf[i] - buf[i + tau];
        sum += diff * diff;
      }
      d[tau] = sum;
    }
    // Cumulative mean normalized difference (CMND). Only compute up to tauMax
    // since the threshold search only reads cmnd[tauMin..tauMax]. Reuse scratch.
    const cmnd = (scratchCmnd && scratchCmnd.length >= halfN) ? scratchCmnd : new Float32Array(halfN);
    cmnd[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      running += d[tau];
      cmnd[tau] = (d[tau] * tau) / (running || 1);
    }

    // Absolute threshold — first τ where CMND drops below threshold AND
    // is a local minimum.
    let tauEstimate = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cmnd[tau] < threshold) {
        while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
        tauEstimate = tau;
        break;
      }
    }
    if (tauEstimate < 0) return null;

    // Parabolic interpolation around the minimum for sub-sample τ.
    let betterTau = tauEstimate;
    if (tauEstimate > 0 && tauEstimate < tauMax) {
      const s0 = cmnd[tauEstimate - 1];
      const s1 = cmnd[tauEstimate];
      const s2 = cmnd[tauEstimate + 1];
      const denom = 2 * (s0 - 2 * s1 + s2);
      if (denom !== 0) {
        betterTau = tauEstimate + (s0 - s2) / denom;
      }
    }

    const freqHz = sampleRate / betterTau;
    if (freqHz < minHz || freqHz > maxHz) return null;
    // Confidence = 1 - CMND at the chosen τ, clamped.
    const conf = Math.max(0, Math.min(1, 1 - cmnd[tauEstimate]));
    return { freqHz, confidence: conf };
  }

  // ── scoring.createContinuous ──────────────────────────────────────────
  // Self-contained (does not use createNoteDetector). Opens its own
  // getUserMedia stream and runs YIN on a 2048-sample window. Emits
  // 'pitch' events with { freqHz, midiFloat, cents, confidence, tMs,
  // expectedBaseFreqHz }. `cents` is relative to expectedBaseFreqHz if
  // provided, otherwise relative to freqHz itself (so always 0).
  function createContinuous(opts) {
    // Coerce expectedBaseFreqHz to a finite positive number, or null.
    // A truthy-but-invalid value (NaN, Infinity, negative, string) would make
    // Math.log2(freq / expectedBaseFreqHz) return NaN and corrupt every emitted
    // pitch event.
    const _rawBase = opts && opts.expectedBaseFreqHz;
    const expectedBaseFreqHz = (typeof _rawBase === 'number' && isFinite(_rawBase) && _rawBase > 0)
      ? _rawBase
      : null;
    const rawSmoothing       = opts && opts.smoothingMs;
    const smoothingMs        = (typeof rawSmoothing === 'number' && isFinite(rawSmoothing) && rawSmoothing > 0)
      ? rawSmoothing
      : 30;
    const handlers = { pitch: [], end: [] };
    let audioCtx    = null;
    let mediaStream = null;
    let source      = null;
    let processor   = null;
    let stopped     = false;
    let lastFreq    = 0;
    let lastConf    = 0;
    let startError  = null;
    const ringSize  = 2048;
    const ring      = new Float32Array(ringSize);
    // Preallocated buffers for YIN — reused every audio callback to avoid
    // per-callback GC pressure from Float32Array allocations inside yinDetect.
    const yinWindow = new Float32Array(ringSize);
    const yinHalfN  = ringSize >> 1;          // 1024 — matches halfN in yinDetect
    const yinD      = new Float32Array(yinHalfN);
    const yinCmnd   = new Float32Array(yinHalfN);
    let ringWrite   = 0;
    // Desktop-engine bridge path. On feedBack-desktop the native JUCE engine
    // owns the input device (often an exclusive ASIO device the browser's
    // getUserMedia can't see), so a renderer getUserMedia stream lands on the
    // wrong/silent Windows-default device. When the bridge is present we pull
    // post-noise-gate frames from the engine instead — same device the player
    // and note_detect read from. getUserMedia stays as the web fallback.
    let bridgePoll       = null;   // setTimeout handle for the engine poll loop
    let usingBridge      = false;
    let bridgeGotFrame   = false;  // first non-empty frame seen (vs downlevel addon)
    let bridgeSampleRate = 48000;  // queried once from the engine

    const handle = {
      on(event, cb) { (handlers[event] || (handlers[event] = [])).push(cb); return handle; },
      stop,
      isRunning: () => !stopped && (!!audioCtx || usingBridge),
    };

    function emit(event, payload) {
      (handlers[event] || []).forEach(cb => { try { cb(payload); } catch (e) { console.error(e); } });
    }

    // Shared analysis used by both the mic and engine-bridge sources. `win` is a
    // ringSize-length Float32Array (oldest→newest); `dtMs` is the elapsed time
    // since the previous frame, driving the log-freq EMA smoothing. RMS-gate →
    // YIN → smooth → emit('pitch'). Keeping this single function guarantees the
    // two sources emit byte-identical frame shapes to consumers.
    function analyzeWindow(win, sampleRate, dtMs) {
      let rms = 0;
      for (let i = 0; i < ringSize; i++) rms += win[i] * win[i];
      rms = Math.sqrt(rms / ringSize);
      // -60 dBFS RMS gate (≈ 0.001 full-scale): on silence YIN's difference
      // function collapses and reports a spurious high-freq lock, so skip it.
      const res = (rms > 0.001)
        ? yinDetect(win, sampleRate, { minHz: 70, maxHz: 1500 }, yinD, yinCmnd)
        : null;
      const nowMs = performance.now();
      if (res && res.confidence > 0.3) {
        const alpha = Math.min(1, (dtMs > 0 ? dtMs : 1) / smoothingMs);
        if (lastFreq > 0) {
          lastFreq = Math.exp(Math.log(lastFreq) * (1 - alpha) + Math.log(res.freqHz) * alpha);
        } else {
          lastFreq = res.freqHz;
        }
        lastConf = res.confidence;
      } else {
        // Fade confidence rather than zeroing — lets the consumer gate "no
        // input" on confidence falling below its own threshold.
        lastConf *= 0.85;
      }
      const freq = lastFreq;
      const midiFloat = freq > 0 ? 69 + 12 * Math.log2(freq / 440) : 0;
      const cents = (expectedBaseFreqHz && freq > 0)
        ? 1200 * Math.log2(freq / expectedBaseFreqHz)
        : 0;
      emit('pitch', {
        freqHz: freq,
        midiFloat,
        cents,
        confidence: lastConf,
        tMs: nowMs,
        expectedBaseFreqHz,
      });
    }

    // getUserMedia source — used on the web build, and on desktop only when the
    // engine bridge is absent. NOTE: on desktop this lands on the Windows-default
    // device, which is usually NOT the guitar (see the bridge path above); the
    // dispatcher in start() prefers the bridge for that reason.
    async function startMic() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          video: false,
        });
        if (stopped) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        mediaStream = stream;
        if (stopped) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        const AC = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AC();
        // Some browsers (Chrome, Safari) start AudioContexts in "suspended"
        // state when constructed outside a direct user-gesture call stack.
        // resume() must be called explicitly; ignore errors (e.g. the context
        // is already running — not an error state we need to surface).
        await audioCtx.resume().catch(() => {});
        if (stopped) {
          audioCtx.close().catch(() => {});
          audioCtx = null;
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        source = audioCtx.createMediaStreamSource(stream);
        // ScriptProcessor is deprecated but universally supported and lets
        // us pull raw frames synchronously — fine for v1. Migration to
        // AudioWorklet is straightforward later.
        const bufSize = 1024;
        processor = audioCtx.createScriptProcessor(bufSize, 1, 1);
        processor.onaudioprocess = (e) => {
          if (stopped) return; // race: stop() called while onaudioprocess was queued
          const inBuf = e.inputBuffer.getChannelData(0);
          // Copy into ring.
          for (let i = 0; i < inBuf.length; i++) {
            ring[ringWrite] = inBuf[i];
            ringWrite = (ringWrite + 1) % ringSize;
          }
          // Build a contiguous window for YIN: from oldest sample to newest.
          // Write into the preallocated yinWindow to avoid per-callback allocs.
          for (let i = 0; i < ringSize; i++) {
            yinWindow[i] = ring[(ringWrite + i) % ringSize];
          }
          // Mic frame interval ≈ bufSize/sampleRate; feed it as the EMA dt.
          analyzeWindow(yinWindow, audioCtx.sampleRate, bufSize / audioCtx.sampleRate * 1000);
        };
        source.connect(processor);
        // Must connect processor → destination for onaudioprocess to fire.
        // Route through a muted gain node so we don't actually output mic.
        const mute = audioCtx.createGain();
        mute.gain.value = 0;
        processor.connect(mute);
        mute.connect(audioCtx.destination);
      } catch (err) {
        console.error('[minigames] continuous scoring failed to start:', err);
        // Do NOT emit 'end' here — stop() will emit one. Tagging the
        // stop() reason via a captured variable keeps subscribers from
        // seeing two events for the same shutdown.
        startError = err;
        stop();
      }
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      if (bridgePoll) { try { clearTimeout(bridgePoll); } catch (e) {} bridgePoll = null; }
      usingBridge = false;
      try { if (processor) processor.disconnect(); } catch (e) {}
      try { if (source) source.disconnect(); } catch (e) {}
      try { if (mediaStream) mediaStream.getTracks().forEach(t => t.stop()); } catch (e) {}
      try { if (audioCtx) audioCtx.close().catch(() => {}); } catch (e) {}
      audioCtx = mediaStream = source = processor = null;
      emit('end', startError
        ? { reason: 'error', error: startError }
        : { reason: 'stopped' });
    }

    // Desktop source: pull post-noise-gate frames from the native JUCE engine
    // (the device the user actually plays through) and run the same YIN. Polled
    // via a self-rescheduling setTimeout — NOT setInterval — so a slow IPC
    // round-trip can't stack callbacks. Falls back to the mic path if the addon
    // is downlevel (getRawAudioFrame resolves an empty array).
    async function startBridge(audio) {
      try {
        // The minigame needs live input; make sure the engine is capturing.
        if (typeof audio.isAudioRunning === 'function') {
          const running = await audio.isAudioRunning();
          if (!running && typeof audio.startAudio === 'function') await audio.startAudio();
        }
      } catch (e) { /* best-effort; poll anyway */ }
      try {
        const sr = await audio.getSampleRate();
        if (typeof sr === 'number' && sr > 0) bridgeSampleRate = sr;
      } catch (e) { /* keep 48000 default */ }
      if (stopped) return;
      usingBridge = true;
      let lastT = performance.now();
      const bridgeStartT = performance.now();
      const POLL_MS = 25;             // ~40 Hz — matches the mic path's cadence
      const BRIDGE_WARMUP_MS = 1500;  // grace for startAudio()/device spin-up
                                      // before concluding there's no frame tap

      const tick = async () => {
        if (stopped) return;
        let frame = null;
        try { frame = await audio.getRawAudioFrame(ringSize); } catch (e) { /* transient IPC hiccup */ }
        if (stopped) return;
        if (!frame || frame.length === 0) {
          // Empty/failed poll. startAudio() above may still be spinning the
          // input device up, so the first frames can legitimately be empty —
          // only conclude the addon has no engine frame tap (downlevel) after a
          // warm-up grace during which no frame ever arrived. A thrown poll is
          // transient and simply retries until that grace elapses.
          if (!bridgeGotFrame && (performance.now() - bridgeStartT) > BRIDGE_WARMUP_MS) {
            usingBridge = false;
            console.warn('[minigames] engine frame tap unavailable — using getUserMedia');
            startMic();
            return;
          }
        } else {
          bridgeGotFrame = true;
          // Copy the newest ringSize samples into yinWindow (left-zero-pad if the
          // engine handed back fewer, e.g. a cold-start partial ring).
          const n = frame.length;
          if (n >= ringSize) {
            for (let i = 0; i < ringSize; i++) yinWindow[i] = frame[n - ringSize + i];
          } else {
            const pad = ringSize - n;
            for (let i = 0; i < pad; i++) yinWindow[i] = 0;
            for (let i = 0; i < n; i++) yinWindow[pad + i] = frame[i];
          }
          const now = performance.now();
          const dt = now - lastT;
          lastT = now;
          analyzeWindow(yinWindow, bridgeSampleRate, dt);
        }
        // Guard the reschedule: a consumer's 'pitch' handler can call stop()
        // synchronously inside analyzeWindow, so re-check before re-arming.
        if (!stopped) bridgePoll = setTimeout(tick, POLL_MS);
      };
      tick();
    }

    // Prefer the desktop engine bridge (correct, user-configured input device);
    // fall back to getUserMedia on the web build or a downlevel addon.
    function start() {
      const audio = window.feedBackDesktop && window.feedBackDesktop.audio;
      if (audio && typeof audio.getRawAudioFrame === 'function') {
        startBridge(audio);
      } else {
        startMic();
      }
    }

    start();
    return handle;
  }

  // ── scoring.createDiscrete / createChord ──────────────────────────────
  // Both wrap window.createNoteDetector from feedBack-plugin-notedetect.
  // For v1 they are thin event re-emitters — minigames using them must
  // run alongside a chart (createNoteDetector needs a highway). Chart-free
  // discrete scoring is out of scope until the scoring-core extraction
  // PR lands.
  function _wrapNoteDetector(opts) {
    const handlers = { hit: [], miss: [], end: [] };
    const fn = window.createNoteDetector;
    if (typeof fn !== 'function') {
      console.warn('[minigames] window.createNoteDetector unavailable — install feedBack-plugin-notedetect for discrete/chord scoring.');
      let _unavailStopped = false;
      return {
        on(event, cb) { (handlers[event] || (handlers[event] = [])).push(cb); return this; },
        stop() {
          if (_unavailStopped) return;
          _unavailStopped = true;
          handlers.end.forEach(cb => { try { cb({ reason: 'unavailable' }); } catch (e) { console.error(e); } });
        },
        isRunning: () => false,
      };
    }
    const inst = fn(opts || {});
    const root = (typeof inst.getRoot === 'function') ? inst.getRoot() : window;
    const onHit  = (e) => handlers.hit.forEach(cb => { try { cb(e.detail); } catch (err) { console.error(err); } });
    const onMiss = (e) => handlers.miss.forEach(cb => { try { cb(e.detail); } catch (err) { console.error(err); } });
    root.addEventListener('notedetect:hit', onHit);
    root.addEventListener('notedetect:miss', onMiss);
    let stopped = false;
    if (typeof inst.enable === 'function') {
      try { inst.enable(); } catch (e) { console.error(e); }
    }
    return {
      on(event, cb) { (handlers[event] || (handlers[event] = [])).push(cb); return this; },
      stop() {
        if (stopped) return;
        stopped = true;
        root.removeEventListener('notedetect:hit', onHit);
        root.removeEventListener('notedetect:miss', onMiss);
        try { inst.destroy && inst.destroy(); } catch (e) {}
        handlers.end.forEach(cb => { try { cb({ reason: 'stopped' }); } catch (e) { console.error(e); } });
      },
      isRunning: () => !stopped,
      noteDetector: inst,
    };
  }

  // ── UI helpers ────────────────────────────────────────────────────────
  function mountHUD(content) {
    const hud = document.getElementById('mg-stage-hud');
    if (!hud) return;
    if (content instanceof Node) {
      hud.innerHTML = '';
      hud.appendChild(content);
    } else if (typeof content === 'string') {
      hud.innerHTML = content;
    }
  }

  function runSummary(result) {
    const root = document.getElementById('mg-summary');
    if (!root) return;
    const spec = registered.get(result.gameId);
    // Prefer the caller-supplied resolvedTitle (manifest-resolved) over the
    // JS spec title so minigames that register a minimal spec still show the
    // correct display name in the post-game summary.
    document.getElementById('mg-summary-game').textContent =
      result.resolvedTitle || (spec ? spec.title || spec.id : '') || (result.gameId || '');
    document.getElementById('mg-summary-score').textContent = String(Math.floor(Math.max(0, Number(result.score) || 0)));
    document.getElementById('mg-summary-xp').textContent    = '+' + String(Math.floor(Math.max(0, Number(result.xpGained) || 0))) + ' dB';
    document.getElementById('mg-summary-best').textContent  = String(Math.floor(Math.max(0, Number(result.best) || 0)));

    const extra = document.getElementById('mg-summary-extra');
    if (result.extra) {
      // Trust boundary: result.extra (summaryHtml) is produced by the game
      // plugin's own end() call — it is first-party, same-origin code, not
      // user-supplied content. innerHTML is intentional here so games can
      // render formatted post-run stats (tables, bold numbers, etc.). If this
      // field ever flows from an untrusted source we must sanitize first.
      extra.innerHTML = result.extra;
    } else {
      extra.textContent = '';
    }

    root.classList.remove('hidden');

    const closeBtn = document.getElementById('mg-summary-close');
    const againBtn = document.getElementById('mg-summary-again');

    const closeSummary = () => {
      root.classList.add('hidden');
      document.removeEventListener('keydown', onKey);
      // Clear the module-level reference so teardownActiveSession() knows
      // there is no stale keydown listener left to clean up.
      _summaryCleanup = null;
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { closeSummary(); renderHub(); }
    };
    document.addEventListener('keydown', onKey);
    // Register the cleanup so teardownActiveSession() can remove the listener
    // if the user navigates away while the summary is visible.
    _summaryCleanup = closeSummary;
    // Move focus into the modal for keyboard/screen-reader users.
    if (closeBtn) setTimeout(() => closeBtn.focus(), 0);

    closeBtn.onclick = () => {
      closeSummary();
      // Re-render hub so updated XP / best appears.
      renderHub();
    };
    againBtn.onclick = () => {
      closeSummary();
      if (spec) start(spec.id, result.lastOpts || {});
      else renderHub();
    };
  }

  // Modifier picker — modal with one row per modifier from the spec.
  // Returns a Promise that resolves to {modifiers} or rejects on cancel.
  function modifierPicker(spec) {
    return new Promise((resolve, reject) => {
      const root = document.getElementById('mg-picker');
      if (!root) { reject(new Error('picker DOM missing')); return; }
      document.getElementById('mg-picker-title').textContent = spec.title || spec.id;
      document.getElementById('mg-picker-tagline').textContent = spec.tagline || '';
      const body = document.getElementById('mg-picker-body');
      body.innerHTML = '';

      const selected = Object.create(null);
      (spec.modifiers || []).forEach(mod => {
        selected[mod.id] = mod.default;
        const row = document.createElement('div');
        row.innerHTML = `
          <div class="text-xs uppercase tracking-widest text-fb-textDim mb-2">${escapeHtml(mod.label || mod.id)}</div>
          <div class="flex gap-2 flex-wrap" data-mod-id="${escapeHtml(mod.id)}"></div>
        `;
        const btnRow = row.querySelector('[data-mod-id]');
        (mod.values || []).forEach(v => {
          const btn = document.createElement('button');
          btn.className = 'px-3 py-1.5 rounded text-sm bg-fb-bg/60 text-fb-textDim hover:bg-fb-border';
          btn.textContent = String(v);
          btn.dataset.value = String(v);
          if (v === mod.default) btn.classList.add('!bg-accent', '!text-white');
          btn.onclick = () => {
            selected[mod.id] = v;
            btnRow.querySelectorAll('button').forEach(b => b.classList.remove('!bg-accent', '!text-white'));
            btn.classList.add('!bg-accent', '!text-white');
          };
          btnRow.appendChild(btn);
        });
        body.appendChild(row);
      });

      // Track selector for chart-free games that ship tracks.
      if (Array.isArray(spec.availableTracks) && spec.availableTracks.length) {
        selected.__track = spec.availableTracks[0].id;
        const row = document.createElement('div');
        row.innerHTML = `
          <div class="text-xs uppercase tracking-widest text-fb-textDim mb-2">Track</div>
          <div class="flex gap-2 flex-wrap" data-mod-id="__track"></div>
        `;
        const btnRow = row.querySelector('[data-mod-id]');
        spec.availableTracks.forEach((t, i) => {
          const btn = document.createElement('button');
          btn.className = 'px-3 py-1.5 rounded text-sm bg-fb-bg/60 text-fb-textDim hover:bg-fb-border';
          btn.textContent = t.title || t.id;
          if (i === 0) btn.classList.add('!bg-accent', '!text-white');
          btn.onclick = () => {
            selected.__track = t.id;
            btnRow.querySelectorAll('button').forEach(b => b.classList.remove('!bg-accent', '!text-white'));
            btn.classList.add('!bg-accent', '!text-white');
          };
          btnRow.appendChild(btn);
        });
        body.appendChild(row);
      }

      root.classList.remove('hidden');

      const cancelBtn = document.getElementById('mg-picker-cancel');
      const startBtn  = document.getElementById('mg-picker-start');

      const onKey = (e) => {
        if (e.key === 'Escape') { cleanup(); reject(new Error('cancelled')); }
      };
      const cleanup = () => {
        root.classList.add('hidden');
        document.removeEventListener('keydown', onKey);
      };
      document.addEventListener('keydown', onKey);
      // Move focus into the modal so keyboard/screen-reader users can proceed.
      if (startBtn) setTimeout(() => startBtn.focus(), 0);

      cancelBtn.onclick = () => { cleanup(); reject(new Error('cancelled')); };
      // Convert the null-proto `selected` map into a plain object. Using
      // Object.fromEntries avoids the Object.assign({}, ...) footgun where
      // a modifier id of '__proto__' would invoke the setter on the target
      // and mutate its prototype — fromEntries always creates own data props.
      startBtn.onclick  = () => {
        cleanup();
        resolve({ modifiers: Object.fromEntries(Object.entries(selected)) });
      };
    });
  }

  // ── Persistence client ────────────────────────────────────────────────
  async function submitRun(payload) {
    const r = await fetch(`${API_BASE}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`submitRun failed: ${r.status}`);
    return r.json();
  }
  async function getLeaderboard(gameId, opts) {
    const params = new URLSearchParams();
    if (gameId) params.set('game_id', gameId);
    if (opts && opts.scope) params.set('scope', opts.scope);
    if (opts && opts.limit) params.set('limit', String(opts.limit));
    const r = await fetch(`${API_BASE}/runs?${params}`);
    if (!r.ok) throw new Error(`getLeaderboard failed: ${r.status}`);
    return r.json();
  }
  async function getProfile() {
    const r = await fetch(`${API_BASE}/profile`);
    if (!r.ok) throw new Error(`getProfile failed: ${r.status}`);
    return r.json();
  }
  async function resetProfile() {
    const r = await fetch(`${API_BASE}/profile/reset`, { method: 'POST' });
    if (!r.ok) throw new Error(`resetProfile failed: ${r.status}`);
    return r.json();
  }
  async function getServerRegistry() {
    const r = await fetch(`${API_BASE}/registry`);
    if (!r.ok) throw new Error(`registry failed: ${r.status}`);
    return r.json();
  }

  // ── Scheduler (AudioContext-relative would be ideal; v1 uses perf.now) ─
  const _timers = new Set();
  const scheduler = {
    every(ms, cb) {
      const id = setInterval(cb, ms);
      _timers.add(id);
      return id;
    },
    in(ms, cb) {
      const id = setTimeout(() => { _timers.delete(id); cb(); }, ms);
      _timers.add(id);
      return id;
    },
    cancel(id) {
      clearTimeout(id);
      clearInterval(id);
      _timers.delete(id);
    },
    now: () => performance.now(),
  };

  // ── Registry ──────────────────────────────────────────────────────────
  const registered = new Map();
  function register(spec) {
    if (!spec || typeof spec.id !== 'string' || !spec.id) {
      console.warn('[minigames] register() called with missing or non-string spec.id');
      return;
    }
    if (typeof spec.start !== 'function') {
      console.warn('[minigames] register(%s): spec.start must be a function', spec.id);
      return;
    }
    registered.set(spec.id, spec);
    // If the hub is mounted, re-render. Otherwise it'll pick this up on next mount.
    if (document.getElementById('mg-grid')) renderHub();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────
  let active   = null;     // { spec, modifiers, resolvedTitle, startedAt, lastOpts }
  let starting = false;    // true while start() is in-flight (before active is set)
  // Monotonically incrementing generation counter. Incremented by
  // teardownActiveSession() so any in-flight _startInner() can detect that it
  // has been superseded and bail after each await without mounting the stage
  // or calling spec.start() for a screen the user has already left.
  let _startGeneration = 0;
  // When runSummary() opens the post-run modal it registers a document-level
  // keydown listener. This variable holds the cleanup function so that
  // teardownActiveSession() can remove the listener even when active is null
  // (i.e. the run is over and the user navigates away while the summary is open).
  let _summaryCleanup = null;

  async function start(gameId, opts) {
    // Guard against concurrent start() calls: `active` is set only after the
    // async registry fetch + modifier picker, so a naive `if (active)` check
    // would allow two calls to enter the async section simultaneously (e.g.
    // a double-tap on a tile). `starting` flips synchronously on entry.
    if (active || starting) { console.warn('[minigames] a game is already active or starting; ignoring start(%s)', gameId); return; }
    starting = true;
    const myGeneration = ++_startGeneration;
    try {
      return await _startInner(gameId, opts, myGeneration);
    } finally {
      starting = false;
    }
  }

  async function _startInner(gameId, opts, myGeneration) {
    const spec = registered.get(gameId);
    if (!spec) { console.warn('[minigames] no such minigame:', gameId); return; }

    // Always fetch the server registry so the resolved title/tagline can be
    // used in both the stage header and the run summary — even when modifiers
    // are supplied directly (e.g. Play Again with cached opts).
    const reg = await getServerRegistry().catch(() => ({ minigames: [] }));
    // Bail if teardownActiveSession() fired while we were awaiting.
    if (myGeneration !== _startGeneration) { return; }
    const manifestSpec = (reg.minigames || []).find(m => m.plugin_id === gameId) || {};
    const resolvedTitle = manifestSpec.title || spec.title || gameId;

    let modifiers = opts && opts.modifiers;
    if (!modifiers) {
      // Build a picker config from the server-side manifest entry (which
      // includes modifiers + unlocks). Manifest fields take precedence;
      // JS spec fields serve as fallback when the manifest omits them.
      const tracks = manifestSpec.availableTracks || spec.availableTracks || null;
      try {
        const pick = await modifierPicker({
          id:               gameId,
          title:            resolvedTitle,
          tagline:          manifestSpec.tagline || spec.tagline || '',
          modifiers:        manifestSpec.modifiers || spec.modifiers || [],
          availableTracks:  tracks,
        });
        modifiers = pick.modifiers;
      } catch (e) {
        return; // cancelled
      }
      // Bail if teardownActiveSession() fired while we were in the picker.
      if (myGeneration !== _startGeneration) { return; }
    }

    // Show the stage chrome.
    const stage = document.getElementById('mg-stage');
    const body  = document.getElementById('mg-stage-body');
    const title = document.getElementById('mg-stage-title');
    const instr = document.getElementById('mg-stage-instrument');
    const quit  = document.getElementById('mg-stage-quit');
    if (!stage || !body || !title || !instr || !quit) {
      console.warn('[minigames] start(%s): stage DOM not mounted — cannot launch', gameId);
      return;
    }
    stage.classList.remove('hidden');
    body.innerHTML = '';
    title.textContent = resolvedTitle;
    instr.textContent = '';
    mountHUD('');

    const container = document.createElement('div');
    container.className = 'mg-game-root';
    body.appendChild(container);

    active = { spec, modifiers, resolvedTitle, startedAt: performance.now(), lastOpts: { modifiers } };
    // Compute elapsed time at quit so the recorded duration reflects actual play
    // time rather than always logging 0ms (which would bypass end()'s fallback).
    quit.onclick = () => end({
      score: 0,
      durationMs: active ? Math.round(performance.now() - active.startedAt) : 0,
      modifiers,
      meta: { reason: 'quit' },
    });

    try {
      await spec.start({
        container,
        modifiers,
        // Convenience pass-through for the SDK so games don't have to
        // touch window.feedBackMinigames inside their start handler.
        sdk: window.feedBackMinigames,
      });
    } catch (e) {
      console.error('[minigames] minigame start() threw:', e);
      // Compute elapsed time so failed starts record meaningful duration rather
      // than always logging 0ms and bypassing end()'s fallback calculation.
      const errDuration = active ? Math.round(performance.now() - active.startedAt) : 0;
      await end({ score: 0, durationMs: errDuration, modifiers, meta: { reason: 'error', error: String(e) } });
    }
  }

  async function end(result) {
    if (!active) return;
    const { spec, modifiers, resolvedTitle, startedAt, lastOpts } = active;
    active = null;

    // Tolerate callers that pass no result (or null/undefined) — normalise to {}.
    const res = (result && typeof result === 'object') ? result : {};

    // Let the game tear itself down first.
    // Note: `await spec.stop && spec.stop()` has a precedence bug — it awaits
    // the function reference, not the call. Explicit check + await is correct.
    try { if (typeof spec.stop === 'function') await spec.stop(); } catch (e) { console.error(e); }
    // Also stop any timers started via scheduler.
    _timers.forEach(t => { clearTimeout(t); clearInterval(t); });
    _timers.clear();

    const _rawDur = Number(res.durationMs);
    const durationMs = (Number.isFinite(_rawDur) && _rawDur >= 0)
      ? Math.floor(_rawDur)
      : Math.round(performance.now() - startedAt);
    const score      = Math.max(0, Math.floor(Number(res.score) || 0));
    // Coerce meta to a plain object — the backend expects a JSON object/dict;
    // a non-object (string, array, null) would cause a Pydantic 422.
    const rawMeta = res.meta;
    const meta    = (rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta))
      ? rawMeta
      : {};

    document.getElementById('mg-stage').classList.add('hidden');
    document.getElementById('mg-stage-body').innerHTML = '';

    let xpGained = 0;
    // Default best to this run's score so the summary shows a sensible value
    // even if the server is unreachable or the leaderboard fetch fails.
    let best = score;
    try {
      const submitted = await submitRun({
        game_id:     spec.id,
        score,
        duration_ms: durationMs,
        modifiers,
        meta,
      });
      xpGained = submitted.xp_gained;
      // Best score: fetch leaderboard top entry.
      const lb = await getLeaderboard(spec.id, { limit: 1 });
      best = (lb.runs && lb.runs[0] && lb.runs[0].score) || score;
    } catch (e) {
      console.error('[minigames] run submission failed:', e);
    }

    runSummary({
      gameId:        spec.id,
      resolvedTitle,
      score,
      xpGained,
      best,
      extra:         res.summaryHtml || '',
      lastOpts,
    });
    // Refresh profile strip.
    renderProfileStrip().catch(() => {});
  }

  // ── Hub controller ────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Serialise hub renders. Concurrent calls were causing duplicate tiles
  // because each call ran `grid.innerHTML = ''` then awaited a fetch then
  // appended its tile, and the async gap let other in-flight renders also
  // clear-then-append, multiplying the tile count by the number of races.
  // We let at most one render run at a time and coalesce trailing calls
  // into a single follow-up.
  let _hubRenderInFlight = false;
  let _hubRenderQueued   = false;
  async function renderHub() {
    if (_hubRenderInFlight) { _hubRenderQueued = true; return; }
    _hubRenderInFlight = true;
    try {
      await _renderHubOnce();
    } catch (e) {
      // _renderHubOnce() failing is non-fatal — the hub just won't update.
      // Swallow here so all fire-and-forget callsites don't need .catch().
      console.error('[minigames] renderHub failed:', e);
    } finally {
      _hubRenderInFlight = false;
      if (_hubRenderQueued) {
        _hubRenderQueued = false;
        // Fire-and-forget; errors are swallowed above.
        renderHub().catch(() => {});
      }
    }
  }

  async function _renderHubOnce() {
    const grid  = document.getElementById('mg-grid');
    const empty = document.getElementById('mg-empty');
    if (!grid || !empty) return;

    // Fetch profile and server registry together. Registry fields (title,
    // tagline, thumbnail) take precedence over the JS-registered spec so
    // minigames that only register the minimal lifecycle spec still render
    // correctly — the canonical display metadata lives in plugin.json.
    const [profileResp, registryResp] = await Promise.all([
      getProfile().catch(() => ({})),
      getServerRegistry().catch(() => ({ minigames: [] })),
    ]);
    await renderProfileStrip(profileResp).catch(() => {});
    const perGame = (profileResp.totals && profileResp.totals.per_game) || {};

    // Build a lookup from plugin_id → manifest entry for merging below.
    // Use Object.create(null) to prevent prototype-pollution if a plugin id
    // were ever '__proto__' or another special key.
    const manifestByGame = Object.create(null);
    (registryResp.minigames || []).forEach(m => { manifestByGame[m.plugin_id] = m; });

    const list = Array.from(registered.values());
    grid.innerHTML = '';
    if (!list.length) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    list.forEach(spec => {
      // Merge manifest fields so display metadata from plugin.json takes
      // precedence over anything in the JS registration (manifest is the
      // authoritative source; JS spec is a runtime fallback).
      const mSpec = manifestByGame[spec.id] || {};
      const title     = mSpec.title     || spec.title     || spec.id;
      const tagline   = mSpec.tagline   || spec.tagline   || '';
      const thumbnail = mSpec.thumbnail || spec.thumbnail || null;

      const tile = document.createElement('div');
      // Reuse the library's .song-card class so minigame tiles look
      // identical to song cards (square art on top, text block below,
      // matching hover/focus behaviour).
      tile.className = 'song-card';
      tile.tabIndex  = 0;
      tile.setAttribute('role', 'button');
      tile.setAttribute('aria-label', title);
      const stats = perGame[spec.id] || { runs: 0, best_score: 0 };
      // Thumbnails are served via the minigame plugin's own asset route
      // (the FeedBack plugin loader only serves manifest-declared files,
      // so each minigame that ships extra assets must expose /assets/).
      // Thumbnails are served by the minigame plugin's own /assets/ route;
      // not every plugin ships one, so fall back to the placeholder on 404.
      const art = thumbnail
        ? `<div class="card-art"><img src="/api/plugins/${encodeURIComponent(spec.id)}/assets/${encodeURIComponent(thumbnail)}" alt="${escapeHtml(title)}" onerror="this.parentElement.innerHTML='<span class=\\'placeholder\\'>🎮</span>'"></div>`
        : `<div class="card-art"><span class="placeholder">🎮</span></div>`;
      tile.innerHTML = `
        ${art}
        <div class="p-4">
          <div class="font-semibold text-white truncate">${escapeHtml(title)}</div>
          <div class="text-sm text-gray-400 mt-0.5 line-clamp-2 min-h-[2.5em]">${escapeHtml(tagline)}</div>
          <div class="mt-3 flex items-center justify-between text-xs text-gray-500">
            <span>Runs <b class="text-gray-300">${Number(stats.runs) || 0}</b></span>
            <span>Best <b class="text-gray-300">${Number(stats.best_score) || 0}</b></span>
          </div>
        </div>
      `;
      tile.onclick = () => start(spec.id);
      tile.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          start(spec.id);
        }
      });
      grid.appendChild(tile);
    });
  }

  // Accepts an already-fetched profile so callers can avoid a redundant
  // network round-trip when they already have the profile in hand.
  // Progression (spec 010): the strip shows lifetime Decibels earned (the
  // profile `xp` field mirrors the unified core store) — the level meter is
  // gone from the UI, but the backend xp/level fields stay for unlocks.
  async function renderProfileStrip(profile) {
    const xp = document.getElementById('mg-profile-xp');
    if (!xp) return;
    const p = profile || (await getProfile());
    xp.textContent = `${Number(p.xp || 0).toLocaleString()} dB`;
  }

  // ── SDK object ────────────────────────────────────────────────────────
  const sdk = {
    __alive: true,
    register,
    start,
    end,
    scoring: {
      createContinuous,
      createDiscrete: (opts) => _wrapNoteDetector(opts),
      createChord:    (opts) => _wrapNoteDetector(opts),
    },
    ui: { mountHUD, runSummary, modifierPicker },
    submitRun,
    getLeaderboard,
    getProfile,
    resetProfile,
    scheduler,
    // Read-only access to the registry for the hub-from-anywhere case.
    listRegistered: () => Array.from(registered.values()),
  };

  window.feedBackMinigames = sdk;
  // Drain queue of plugins that loaded before us.
  (window.__feedBackMinigamesPending || []).forEach(register);
  window.__feedBackMinigamesPending = null;

  // ── Back-compat for pre-rename minigame plugins ───────────────────────
  // Minigame plugins published before the slopsmith→feedBack rename (#537)
  // register against `window.slopsmithMinigames` and, when the SDK isn't up
  // yet, queue to `window.__slopsmithMinigamesPending`. The rename moved the
  // SDK to `window.feedBackMinigames` and only drains the feedBack queue, so
  // those plugins' specs — including community ones we don't control — get
  // stranded in the legacy queue and never register. Their FeedBarcade tiles
  // then render as dead "Loading…" placeholders that do nothing on click.
  // Alias the SDK under the old name and drain the legacy pending queue too.
  // register() is keyed on spec.id, so a plugin that queued under both names
  // still registers exactly once.
  window.slopsmithMinigames = sdk;
  (window.__slopsmithMinigamesPending || []).forEach(register);
  window.__slopsmithMinigamesPending = null;

  window.dispatchEvent(new CustomEvent('feedBack-minigames-ready'));
  // Legacy event name for any pre-rename listener still bound to it.
  window.dispatchEvent(new CustomEvent('slopsmith-minigames-ready'));

  // ── Wire hub render to screen lifecycle ───────────────────────────────
  // FeedBack mounts plugin screens with id "plugin-<plugin_id>" and
  // routes there via showScreen() / window.feedBack.navigate().
  const SCREEN_ID = `plugin-${PLUGIN_ID}`;
  // Non-scoring teardown: called when navigation happens mid-run so that
  // microphone streams, timers, and stage DOM are cleaned up without submitting
  // a zero-score run.
  async function teardownActiveSession(reason) {
    if (!active && !starting && !_summaryCleanup) return;
    // Increment the generation so any in-flight _startInner() bails at its
    // next await point without mounting the stage or calling spec.start().
    _startGeneration++;
    const spec = active && active.spec;
    active   = null;
    starting = false;
    // Dismiss the summary modal and remove its document-level keydown listener
    // if the user navigated away while the post-run summary was open.
    if (_summaryCleanup) { try { _summaryCleanup(); } catch (e) {} }
    try { if (spec && typeof spec.stop === 'function') await spec.stop(); } catch (e) { console.error('[minigames] teardown spec.stop failed:', e); }
    _timers.forEach(t => { clearTimeout(t); clearInterval(t); });
    _timers.clear();
    const stage = document.getElementById('mg-stage');
    if (stage) stage.classList.add('hidden');
    const stageBody = document.getElementById('mg-stage-body');
    if (stageBody) stageBody.innerHTML = '';
    const summaryEl = document.getElementById('mg-summary');
    if (summaryEl) summaryEl.classList.add('hidden');
    console.info('[minigames] active session torn down (reason=' + reason + ')');
  }

  if (window.feedBack && typeof window.feedBack.on === 'function') {
    window.feedBack.on('screen:changed', (e) => {
      const id = e && e.detail && e.detail.id;
      if (id === SCREEN_ID) {
        renderHub();
      } else if (active || starting || _summaryCleanup) {
        // Teardown covers: active run, in-flight startup, and post-run summary
        // left open while the user navigated away.
        //
        // Exception: a "chart-backed" minigame (spec.usesPlayer) navigates to
        // the player ON PURPOSE and drives it — it overlays its own HUD there
        // and ends the run itself via sdk.end() (and handles abandonment FROM
        // the player from inside the game). Don't tear it down for that one hop.
        // Navigating to any OTHER screen still tears down here as usual — which
        // covers abandoning the pre-run setup UI before the player ever loads.
        if (id === 'player' && active && active.spec && active.spec.usesPlayer) {
          return;
        }
        teardownActiveSession('screen-changed').catch((err) => {
          console.error('[minigames] teardown failed:', err);
        });
      }
    });
  }
  // Initial render in case the DOM is already mounted (hot reload / direct load).
  if (document.getElementById('mg-grid')) {
    renderHub();
  }

  // ── Inject a top-level nav link (not the plugin dropdown) ─────────────
  // The user wants Minigames alongside Library / Favorites / Upload /
  // Settings — not buried in the "Plugins" dropdown. We removed `nav`
  // from plugin.json so the auto-injected dropdown item is gone; this
  // block adds a top-level link instead, and is idempotent so plugin
  // reloads or hot-refreshes don't double-add.
  // Each anchor is added independently — the mobile menu DOM may not exist
  // on the first call (e.g. plugin loads before the mobile nav is rendered),
  // so we must NOT short-circuit on "desktop already exists". We retry on
  // a short cadence so the mobile link gets added when its anchor appears.
  function installNavLink() {
    const navigateToHub = (e) => {
      if (e) e.preventDefault();
      if (window.feedBack && typeof window.feedBack.navigate === 'function') {
        window.feedBack.navigate(SCREEN_ID);
      } else if (typeof window.showScreen === 'function') {
        window.showScreen(SCREEN_ID);
      }
    };

    // Desktop: insert just before the plugin dropdown span (visual order
    // becomes Library / Favorites / Upload / Minigames / [Plugins…] /
    // Settings).
    if (!document.getElementById('mg-nav-link-desktop')) {
      const pluginsAnchor = document.getElementById('nav-plugins');
      if (pluginsAnchor && pluginsAnchor.parentElement) {
        const a = document.createElement('a');
        a.id = 'mg-nav-link-desktop';
        a.href = '#';
        a.className = 'text-sm text-gray-400 hover:text-white transition';
        a.textContent = 'Minigames';
        a.addEventListener('click', navigateToHub);
        pluginsAnchor.parentElement.insertBefore(a, pluginsAnchor);
      }
    }

    // Mobile: insert just before the mobile plugin block (which itself
    // sits inside #mobile-menu).
    if (!document.getElementById('mg-nav-link-mobile')) {
      const mobileAnchor = document.getElementById('mobile-nav-plugins');
      if (mobileAnchor && mobileAnchor.parentElement) {
        const m = document.createElement('a');
        m.id = 'mg-nav-link-mobile';
        m.href = '#';
        m.className = 'text-gray-400 hover:text-white';
        m.textContent = 'Minigames';
        m.addEventListener('click', (e) => {
          navigateToHub(e);
          const mobileMenu = document.getElementById('mobile-menu');
          if (mobileMenu) mobileMenu.classList.add('hidden');
        });
        mobileAnchor.parentElement.insertBefore(m, mobileAnchor);
      }
    }
  }
  installNavLink();
  // The feedBack plugin loader rebuilds the dropdown when plugins
  // hot-reload — re-install on a short delay then settle.
  setTimeout(installNavLink, 250);
  setTimeout(installNavLink, 1500);

  // Re-install the nav link whenever the nav containers are mutated (e.g.
  // after loadPlugins() clears and rebuilds #nav-plugins / #mobile-nav-plugins).
  // We watch the desktop nav parent and the body for the mobile-menu insertion,
  // debouncing with rAF so rapid successive mutations fire a single re-install.
  (function watchNavMutations() {
    if (typeof MutationObserver === 'undefined') return;
    let _rafPending = false;
    const onMutation = () => {
      if (_rafPending) return;
      _rafPending = true;
      requestAnimationFrame(() => {
        _rafPending = false;
        // Only re-install when our link is actually gone (idempotent guard
        // inside installNavLink checks id existence, but this outer check
        // avoids calling the function on unrelated mutations).
        if (!document.getElementById('mg-nav-link-desktop') ||
            !document.getElementById('mg-nav-link-mobile')) {
          installNavLink();
        }
      });
    };
    const obs = new MutationObserver(onMutation);
    // Observe the top-level nav bar and the body (mobile menu is inserted lazily).
    const nav = document.querySelector('nav') || document.body;
    obs.observe(nav, { childList: true, subtree: true });
  })();
})();
