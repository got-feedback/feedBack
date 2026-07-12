/**
 * Canvas-based note highway renderer.
 * Receives note data via WebSocket, renders on requestAnimationFrame.
 */
import {
    BG,
    CHAIN_GAP_THRESHOLD,
    CHAIN_RENDER_FULL_MAX,
    CHORD_FRAME_FRETS,
    DEFAULT_STRING_BRIGHT,
    DEFAULT_STRING_COLORS,
    DEFAULT_STRING_DIM,
    FRETLINE_TARGET_OFFSET,
    FRETLINE_WINDOW_AFTER,
    FRETLINE_WINDOW_BEFORE,
    MAX_RENDERER_DRAW_FAILURES,
    MUTE_BOX_BAR,
    MUTE_BOX_STROKE,
    REPEAT_BOX_BAR,
    REPEAT_BOX_FILL,
    VISIBLE_SECONDS,
    Z_CAM,
    Z_MAX,
    _AUTO_ADJUST_COOLDOWN_MS,
    _AUTO_SCALE_MIN,
    _AUTO_UPSCALE_COOLDOWN_MS,
    _CHART_MAX_INTERP_MS,
    _DOM_VIS_CHECK_FRAMES,
    _DRAW_BUDGET_HI_MS,
    _DRAW_BUDGET_LO_MS,
    _LYRIC_MEASURE_INNER_MAX,
    _LYRIC_MEASURE_OUTER_MAX,
    _PAUSED_FRAME_INTERVAL_MS,
    _SHIMMER_LUT_SIZE,
} from './js/highway-constants.js';
import {
    bnvNormalizedPoints,
    chordHarmonyLabels,
    project,
    roundRect,
    teachingDegreeLabel,
    teachingFingerLabel,
} from './js/highway-geometry.js';
import {
    _noteState,
    _paintGemGlow,
    fillTextReadable,
    fretX,
} from './js/highway-state-primitives.js';

function createHighway() {
  // R3c: per-instance mutable state in one object, so extracted renderer/ws
  // modules can close over it as a factory arg without cross-panel sharing.
  const hwState = {};

    // ── Stable, hwState-bound views of the carved primitives (R3c) ──────────────
    //
    // fretX and _noteState moved to ./js/highway-state-primitives.js and now take hwState as
    // their first argument — they must, because createHighway() is a FACTORY and a module
    // cannot import per-instance state without two panels silently sharing it.
    //
    // But the RENDERER BUNDLE hands both straight to plugins (b.fretX, b.getNoteState), and
    // highway_3d calls them EVERY FRAME with the old arity. Handing out the 3-arg versions
    // would have passed `note` where hwState belongs — no throw, just wrong geometry and wrong
    // judgment state, inside a plugin, which no core test would ever see.
    //
    // So bind hwState ONCE, here, per instance. A per-frame arrow would fix the arity and
    // reintroduce exactly the per-frame allocation the bundle's stable-reference contract
    // (feedBack#254) exists to prevent. These are created once and reused forever.
    //
    // b.project needs none of this: project() is pure, and its arity never changed.
    const boundFretX = (fret, scale, w) => fretX(hwState, fret, scale, w);
    const boundNoteState = (note, chartTime) => _noteState(hwState, note, chartTime);
    
    // Promise chain for serializing async ws.onmessage handlers —
    // reset on each connect() so reconnections start a fresh chain.
    hwState._msgChain = Promise.resolve();
    // Monotonically-increasing connection generation counter.
    // Incremented on every connect() so async handlers that survive a
    // reconnect can detect they are stale and bail out before mutating
    // shared state.
    hwState._wsGen = 0;
    // The audio-element accessor below is polled by plugins, so record its
    // legacy bridge hit only once per highway instead of on every call —
    // otherwise a per-frame poller floods playback:bridge-hit events and
    // diagnostics.
    hwState._audioElementBridgeRecorded = false;
    // Pending JUCE routing promise for the current connection's song_info.
    // The 'ready' handler awaits this so _juceMode is settled before
    // _onReady / song:ready fire, without blocking note/chord processing.
    hwState._juceRoutingPromise = Promise.resolve();

    function _audioSession() {
        return window.feedBack && window.feedBack.audioSession;
    }

    function _reportAudioSessionStart(info) {
        const session = _audioSession();
        if (!session || typeof session.startSession !== 'function') return;
        try {
            session.startSession({
                sessionId: `main:${info && (info.filename || info.title || 'song')}`,
                playerId: 'main',
                songKey: info && (info.filename || info.audio_url || info.title),
                songFormat: info && (info.format || 'unknown'),
            });
        } catch (_) { /* audio-session diagnostics are best-effort */ }
    }

    function _reportAudioRoute(routeKind, availability, reason) {
        const session = _audioSession();
        if (!session || typeof session.setRoute !== 'function') return;
        try {
            session.setRoute({ routeId: 'song-output', routeKind, availability: availability || 'available', selectedByUser: true, fallbackReason: reason || '' });
        } catch (_) { /* audio-session diagnostics are best-effort */ }
    }

    function _reportAudioMonitoring(monitoringId, state, reason) {
        const session = _audioSession();
        if (!session || typeof session.startMonitoring !== 'function') return;
        try {
            session.startMonitoring({ monitoringId, participantId: 'core.juce-route', state, failureReason: reason || '' });
        } catch (_) { /* audio-session diagnostics are best-effort */ }
    }

    function _reportAudioBridge(bridgeId, domain, legacySurface, outcome, reason) {
        const session = _audioSession();
        if (!session || typeof session.recordBridgeHit !== 'function') return;
        try {
            session.recordBridgeHit({ bridgeId, domain, legacySurface, participantId: 'core.highway', outcome: outcome || 'handled', reason: reason || '' });
        } catch (_) { /* audio-session diagnostics are best-effort */ }
    }
    // Two notions of "now" — kept deliberately separate:
    //   chartTime — audio-aligned clock. What getTime() exposes to plugins
    //               (scoring, note detection, etc.) and what setTime() receives.
    //   currentTime — rendering clock. Equal to chartTime + avOffsetSec, so the
    //                 draw code can shift visual notes forward to compensate
    //                 for audio-output pipeline latency without plugins having
    //                 to care about the offset.
    // avOffsetSec is set by setAvOffset(ms); default 0 means old behavior.
    hwState.chartTime = 0;
    hwState.currentTime = 0;
    hwState.avOffsetSec = 0;
    hwState.songOffset = 0.0;  // per-song chart offset (loose-folder format only)
    // Monotonic getTime support: between setTime() calls, getTime()
    // interpolates forward using performance.now() so plugins observe a
    // smooth sub-frame clock instead of the coarse step-quantization
    // that audio.currentTime exposes (browsers don't refresh the
    // reported value every audio frame — the practical gap between
    // distinct readings is closer to 20+ ms in Chrome/Firefox even
    // though the underlying audio thread runs much faster). The anchor
    // only updates when setTime() receives a
    // genuinely new value — repeated calls with the same chartTime
    // (e.g. browser hasn't refreshed audio.currentTime yet) keep the
    // anchor's perfNow fixed so interpolation continues from the right
    // origin instead of stuttering.
    // NaN sentinel for "no prior anchor" so the very first setTime call
    // always triggers the re-anchor branch — even setTime(0) on the
    // initial 60 Hz tick. Plain 0 would compare equal to setTime(0) and
    // skip the branch, leaving _chartAnchorPerfNow uninitialized and
    // causing getTime() to return NaN.
    hwState._chartAnchorAudioT = NaN;
    hwState._chartAnchorPerfNow = NaN;
    // Pause detection: the 60Hz tick in app.js keeps calling setTime()
    // even while paused (with a stalled audio clock). Track when t last
    // ADVANCED (not just when setTime was called) — if it's been still
    // for a while, audio is paused and getTime() should return raw
    // chartTime instead of interpolating forward against silent audio.
    // Independent of song:* events — avoids the edge cases where the
    // pause listener early-returns and never emits.
    hwState._chartLastAdvanceAt = 0;
    // Observed playback rate, derived from the actual delta between
    // successive anchor updates. FeedBack's speed slider (audio
    // playbackRate != 1) means audio time advances slower/faster than
    // real time; interpolating with a fixed 1x rate would drift. Each
    // re-anchor refines the estimate from the latest segment. Default
    // to 1 until we have two anchors to compare.
    hwState._chartObservedRate = 1;
    // Visibility-aware rAF (feedBack#246): when the canvas is hidden
    // (display:none on itself or any ancestor — e.g. splitscreen's
    // workaround), pause renderer.draw and emit highway:visibility on
    // transitions so renderers that mount sibling DOM (3D Highway's
    // .h3d-wrap overlay) can hide it. _visibleOverride !== null forces
    // the state for hosts that hide via opacity / visibility / clipping
    // where offsetParent === null isn't enough.
    hwState._visibleOverride = null;
    hwState._lastVisible = null;
    hwState._domVisCached = false;
    hwState._domVisSampledFrame = NaN;
    hwState.animFrame = null;
    hwState._lastPausedDrawAt = 0;
    hwState._connectOpts = {};
    hwState._resizeContainer = null;
    hwState._resizeHandler = null;
    hwState._onLyricsChange = null;

    // Song data (populated via WebSocket)
    hwState.songInfo = {};
    hwState.notes = [];
    hwState.chords = [];
    hwState.handShapes = [];
    hwState.beats = [];
    hwState.sections = [];
    hwState.anchors = [];
    hwState.chordTemplates = [];
    // Number of strings on the active arrangement. Updated from the
    // `stringCount` field in each `song_info` WS message; falls back
    // to `tuning.length` (works for older servers that don't yet emit
    // stringCount) then to 6 (final safety). 4 = bass, 6 = guitar,
    // 7+ = extended-range GP imports.
    hwState.stringCount = 6;
    hwState.lyrics = [];
    // Provenance of the active lyric set. Set from the highway WS `lyrics`
    // message's `source` field; empty when no lyrics have arrived yet or the
    // source produced lyrics without provenance (e.g. legacy GP imports).
    // Exposed via the bundle + getLyricsSource() so plugins can render an
    // "auto-transcribed" badge for whisperx-sourced lyrics.
    hwState.lyricsSource = "";
    hwState.toneChanges = [];
    hwState.toneBase = "";
    // Drum-tab payload (sloppak-spec §5.3). When the active sloppak's
    // manifest carries a `drum_tab:` key, the server streams a `drum_tab`
    // metadata message followed by chunked `drum_hits`. `drumTab.hits` is
    // concatenated across chunks and exposed on the bundle so the drums
    // plugin can render the new shape language instead of decoding the
    // legacy guitar-encoded `notes` stream. Stays at the null sentinel
    // for non-drum-tab songs so plugins can distinguish "no drums" from
    // "drums loaded but empty".
    hwState.drumTab = null;  // { version, name, kit: [...], hits: [...] }
    hwState.ready = false;
    // Master-difficulty (feedBack#48). _phrases stays null as a
    // "slider disabled" sentinel when the source chart has no ladder
    // data (GP imports, legacy sloppak) — the server omits the
    // `phrases` message entirely in that case. When populated, the
    // filter maps the slider fraction to a per-phrase level index and
    // stages _filteredNotes / _filteredChords for the render loop.
    // _filteredNotes === null means "fall through to flat notes" —
    // either no phrase data or filter not rebuilt yet.
    hwState._phrases = null;
    // Default to full chart. Persistence lives in the caller (app.js
    // loadSettings, or a splitscreen plugin managing its own panel
    // state) so multiple createHighway() instances stay truly
    // per-instance — no shared localStorage key to race on.
    hwState._mastery = 1;
    hwState._filteredNotes = null;
    hwState._filteredChords = null;
    hwState._filteredAnchors = null;
    hwState._filteredHandShapes = null;
    // Tracks whether ANY phrase level carries handshape data. Lets us
    // distinguish "this difficulty has none" (respect strictly — even
    // when empty) from "the chart's phrase data never authored any
    // handshapes at all" (fall back to the flat list so 3D arpeggio
    // hints still work on DLC that ships handshapes only on the
    // arrangement root). Without this flag the bundle would silently
    // surface arp-frame hints at low-mastery levels that shouldn't
    // have any.
    hwState._phrasesHaveHandShapes = false;
    hwState.showLyrics = localStorage.getItem('showLyrics') !== 'false';
    // Teaching marks (§6.2.2): the fret-hand finger numeral (fg) renders by
    // default (small, on the gem), but the scale-degree (sd) + strum-group (ch)
    // overlays are opt-in so the default highway stays uncluttered. Display only
    // — never used for grading.
    hwState._showTeachingMarks = localStorage.getItem('showTeachingMarks') === 'true';
    // Fret-hand finger (fg) hints are shown by DEFAULT (the most broadly useful
    // teaching mark) but independently hideable — separate from the sd/ch opt-in
    // above so the two defaults (fg on, sd/ch off) can coexist. Default-true: an
    // absent key reads as on; only an explicit 'false' hides it.
    hwState._showFingerHints = localStorage.getItem('showFingerHints') !== 'false';
    hwState._drawHooks = [];  // plugin draw callbacks: fn(ctx, W, H)
    // feedBack#254 — per-note judgment overlay. A plugin (note_detect)
    // registers fn(note, chartTime) -> 'hit' | 'active' | 'miss' | null
    // (or { state, alpha?, color? }); renderers consult it per visible
    // note so the gem itself can light up / a held sustain can glow,
    // instead of relying on a separate overlay ring. null = no provider.
    hwState._noteStateProvider = null;
    // 1 = full, 0.5 = half res. Sanitize on load the same way setRenderScale
    // clamps: a corrupt/out-of-range localStorage value (NaN, 0, >1) would
    // otherwise flow into _effectiveRenderScale() and zero the canvas.
    hwState._renderScale = (function () {
        const v = parseFloat(localStorage.getItem('renderScale') || '1');
        return Number.isFinite(v) ? Math.max(0.25, Math.min(1, v)) : 1;
    })();
    // Load-adaptive render scale (feedBack#654). _renderScale is the
    // user's manual ceiling; _autoScale is an automatic multiplier the
    // draw loop lowers when the active renderer's per-frame cost blows
    // the budget (a heavy 3D Highway WebGL scene on a weak GPU, or on
    // high-refresh + ANGLE where Chromium runs the loop at the fastest
    // monitor's rate) and raises again once headroom returns. The scale
    // actually applied to the canvas backing store + bundle.renderScale
    // is _renderScale * _autoScale, floored at the user-configurable
    // _autoScaleMin (the applied floor is capped at the _renderScale ceiling
    // inside _effectiveRenderScale) — so an
    // auto change flows through the exact same plumbing as a manual
    // setRenderScale. Adapting resolution (not frame rate) keeps motion
    // at the display's native refresh, avoiding judder, and never
    // affects sync (note position is clock-derived).
    hwState._autoScale = 1;
    hwState._drawMsEMA = 0;              // smoothed cost of _renderer.draw()
    hwState._frameMsEMA = 0;            // smoothed frame interval (for the HUD)
    hwState._lastFramePerf = 0;
    hwState._lastAutoAdjustAt = 0;
    hwState._lastUpscaleAt = 0;          // separate, longer clock for UPscaling (lazy)
    hwState._perfHud = null;
    hwState._hudOn = false;       // cached highwayPerfHud flag (re-read ~2x/sec, not per-frame)
    hwState._hudFlagAt = 0;
  // sustained draw cost above this -> scale down
   // sustained draw cost below this -> scale back up
   // hard floor (lowest the user-configurable floor may be set)
    // User-configurable floor for the load-adaptive render scale (#654):
    // 0.25 = stock (can drop to quarter-res on heavy frames → pixelated),
    // 1.0 = never auto-downscale below the Quality (renderScale) ceiling — so
    // it's only "full resolution" when Quality is HD; otherwise it pins at the
    // chosen Quality. Read once here; live changes come through
    // api.setMinRenderScale(), surfaced as the "Min res" control next to Quality
    // in the player controls (static/v3/index.html).
    hwState._autoScaleMin = (function () {
        const v = parseFloat(localStorage.getItem('highwayMinRenderScale'));
        return Number.isFinite(v) ? Math.max(_AUTO_SCALE_MIN, Math.min(1, v)) : _AUTO_SCALE_MIN;
    })();
    hwState._inverted = localStorage.getItem('invertHighway') === 'true';
    hwState._lefty = localStorage.getItem('lefty') === '1';
    hwState._lastChordOnFretLine = null;  // chord object currently shown on fret line
    hwState._chordFretLineNotes = [];  // notes to render on fret line
    const _frameMismatchWarned = new Set();  // chord ids already warned about (feedBack#88)
    // Per-chord render info, computed lazily once per src array (feedBack#88).
    const _chordRenderInfo = new WeakMap();  // chord -> { chainIndex, chainLen, isFull, baseFret, sortedNotes, nonZeroNotes, nonZeroFrets, allMuted, hasMultipleNotes }
    hwState._chordRenderCacheSrc = null;
    hwState._chordRenderCacheInverted = null;
    // Also invalidate when chordTemplates is reassigned (WS 'chord_templates'
    // can land AFTER 'chords' chunks, and `isOpen(cn)` — used to compute
    // cached nonZeroNotes/nonZeroFrets — depends on the template lookup).
    hwState._chordRenderCacheTemplates = null;

    // Frame counter for cheap deterministic "random" lookups (sustain
    // shimmer). Incremented once per rAF in draw().
    hwState._frameIdx = 0;

    const _shimmerLut = new Float32Array(_SHIMMER_LUT_SIZE);
    for (let i = 0; i < _SHIMMER_LUT_SIZE; i++) {
        let x = (i + 1) | 0;       // +1 dodges the all-zero xorshift trap
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        _shimmerLut[i] = (x >>> 0) / 4294967296;
    }
    function _shimmerNoise(seed) {
        // Mask works only because _SHIMMER_LUT_SIZE is a power of two
        // (see comment at the LUT declaration above).
        return _shimmerLut[(seed >>> 0) & (_SHIMMER_LUT_SIZE - 1)];
    }

    const _lyricMeasureCache = new Map();   // Map<fontSize, Map<text, width>>
    function _measureLyricText(c, fontSize, text) {
        let inner = _lyricMeasureCache.get(fontSize);
        if (inner === undefined) {
            if (_lyricMeasureCache.size >= _LYRIC_MEASURE_OUTER_MAX) _lyricMeasureCache.clear();
            inner = new Map();
            _lyricMeasureCache.set(fontSize, inner);
        }
        let w = inner.get(text);
        if (w === undefined) {
            if (inner.size >= _LYRIC_MEASURE_INNER_MAX) inner.clear();
            w = c.measureText(text).width;
            inner.set(text, w);
        }
        return w;
    }

    hwState.STRING_COLORS = DEFAULT_STRING_COLORS.slice();
    hwState.STRING_DIM = DEFAULT_STRING_DIM.slice();
    hwState.STRING_BRIGHT = DEFAULT_STRING_BRIGHT.slice();

    // ── String-color helpers ─────────────────────────────────────────────
    function _clampByte(n) { return n < 0 ? 0 : (n > 255 ? 255 : Math.round(n)); }
    function _parseHex(hex) {
        if (typeof hex !== 'string') return null;
        let h = hex.trim().replace(/^#/, '');
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
        return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
    }
    function _toHex(r, g, b) {
        const s = (n) => _clampByte(n).toString(16).padStart(2, '0');
        return '#' + s(r) + s(g) + s(b);
    }
    // Darken toward black: factor 0..1 (0.4 keeps 40% of each channel),
    // matching the look of the default DIM band behind gems.
    function _darken(hex, factor) {
        const c = _parseHex(hex); if (!c) return hex;
        return _toHex(c.r * factor, c.g * factor, c.b * factor);
    }
    // Brighten by mixing toward white: t 0..1 fraction of white blended in.
    function _lighten(hex, t) {
        const c = _parseHex(hex); if (!c) return hex;
        return _toHex(c.r + (255 - c.r) * t, c.g + (255 - c.g) * t, c.b + (255 - c.b) * t);
    }

    // ── Anchor / Fret mapping ────────────────────────────────────────────
    // Zoom approach: fret 0 at the left edge, fret N at the right (entire canvas mirrored when lefty).
    // The "zoom level" determines how many frets are visible.
    // When playing low frets, zoom in (fewer frets visible, bigger notes).
    // When playing high frets, zoom out (more frets visible, smaller spacing).
    hwState.displayMaxFret = 12;  // rightmost visible fret (smoothed)

    function getAnchorAt(t) {
        // Same master-difficulty fallback as the render loops — the
        // anchor ladder pairs with the note ladder.
        const src = hwState._filteredAnchors !== null ? hwState._filteredAnchors : hwState.anchors;
        let a = src[0] || { fret: 1, width: 4 };
        for (const anc of src) {
            if (anc.time > t) break;
            a = anc;
        }
        return a;
    }

    function getMaxFretInWindow(t) {
        // Find the highest fret needed across all anchors visible on screen
        const src = hwState._filteredAnchors !== null ? hwState._filteredAnchors : hwState.anchors;
        let maxFret = 0;
        for (const anc of src) {
            if (anc.time > t + VISIBLE_SECONDS + 2) break; // Skip anchors well in the future (with a little buffer to avoid moving early the cutoff)
            if (anc.time + 2 < t) continue;  // skip anchors well in the past
            const top = anc.fret + anc.width;
            if (top > maxFret) maxFret = top;
        }
        return maxFret;
    }

    function updateSmoothAnchor(anchor, dt) {
        // Smoothing rate balances two regressions seen in feedBack#88:
        //   rate=1.0 (was) snapped to target every frame — visible jitter
        //   on aerial passages where anchors moved every few frames.
        //   rate=0.15 (Knaifhogg) was too gentle — large jumps (low frets
        //   to teens) took ~3s to catch up, pushing upcoming notes off the
        //   right edge.
        // 0.4 splits the difference: half-life ~1.7s, but the per-frame
        // step at 60fps is ~0.0067 — still small enough that frame-to-frame
        // changes read as smooth.
        const rate = Math.min(0.4 * dt, 0.4);
        // Look ahead: use the widest fret range across all visible anchors
        const lookAheadMax = getMaxFretInWindow(hwState.currentTime);
        const currentMax = anchor.fret + anchor.width;
        const needed = Math.max(currentMax, lookAheadMax);
        const targetMax = Math.max(needed + 3, 8);
        hwState.displayMaxFret += (targetMax - hwState.displayMaxFret) * rate;
    }

    /** Map a bend curve [{t, v}] (§6.2.1) to [{x, v}] with x normalized to
     * 0..1 across the curve's time span (0 when the span is degenerate).
     * Pure — drives the 2D bend-shape glyph. */
    /** Teaching mark (§6.2.2): fret-hand-finger label for a note's `fg`.
     * '' when unset/out of range; 0 → 'T' (thumb), 1..4 → '1'..'4'. Pure. */
    /** Teaching mark (§6.2.2): scale-degree label for a note's `sd` (chromatic
     * 0..11 above the active key tonic). '' when unset/out of range. Pure. */
    /** Harmony annotations (§6.3.1 / §6.6): display labels for a chord's
     * harmonic function (the instance `fn.rn` Roman numeral) and its template
     * `voicing`, `caged` shape, and `guideTones`. Returns '' for each when
     * absent or malformed; `caged`/`guideTones` come back pre-formatted
     * ("CAGED: E" / "gt 4,10"). Pure; node-tested and shared by both highways.
     * Display/teaching only — MUST NEVER feed a grader (honesty rule). */
    /** Teaching mark (§6.2.2): bucket drawn notes by their strum-group key `ch`.
     * Returns the groups (in first-seen order) for each ch value >= 0 that has
     * at least two members — a lone note is not a strum gesture. Pure; drives
     * the strum-bracket overlay and is node-tested. */
    function strumGroupBuckets(items) {
        if (!Array.isArray(items)) return [];
        const order = [];
        const byKey = new Map();
        for (const it of items) {
            const ch = it && Number.isInteger(it.ch) ? it.ch : -1;
            if (ch < 0) continue;
            if (!byKey.has(ch)) { byKey.set(ch, []); order.push(ch); }
            byKey.get(ch).push(it);
        }
        return order.map(k => byKey.get(k)).filter(g => g.length >= 2);
    }

    /** Call while lefty mirror transform is active; keeps glyphs readable. */
    // Stable bundle accessor for the registered provider — see
    // bundle.getNoteStateProvider below. Defined once per createHighway()
    // instance (not module scope — _noteStateProvider is per-instance),
    // so _makeBundle() doesn't reallocate an arrow function per frame
    // (matches getNoteState: _noteState's stable-reference pattern).
    function _getNoteStateProvider() { return hwState._noteStateProvider; }

    // ── Drawing ──────────────────────────────────────────────────────────
    //
    // feedBack#36 — swappable renderers.
    //
    // The default renderer below is the original 2D canvas highway. Its
    // methods still reach into the factory closure (ctx, beats, notes,
    // _drawHooks, etc.) to avoid rewriting every helper; it's not
    // "isolated," just shaped as the contract. Custom renderers from
    // plugins (3D, tab, fretboard, future "keys"/"drums") pass through
    // setRenderer() and consume the bundle instead of the closure —
    // they stay self-contained and never touch the factory's `ctx`.
    //
    // Lifecycle: setRenderer(r) -> previous.destroy() -> r.init(canvas,
    // bundle) -> per frame r.draw(bundle) -> on resize r.resize(w, h) ->
    // on stop or swap r.destroy(). Renderer owns its rendering context
    // (2D, WebGL, DOM overlay). Factory owns canvas element, rAF, WS,
    // data state, resize subscription, _drawHooks for 2D compositing.
    //
    // Contract for setRenderer(r): r is an object with at minimum
    // {draw(bundle)}. init / resize / destroy are optional. Pass null
    // or undefined to restore the default renderer.
    //
    // The bundle (see _makeBundle) is a per-frame snapshot of factory
    // state — includes difficulty-filtered note / chord / anchor arrays
    // so renderers never touch _filteredX internals directly. Arrays
    // are live references (performance), NOT copies — renderers must
    // treat them as read-only.
    hwState._renderer = null;

    // Tracks the rendering context type currently bound to the canvas
    // element (`'2d'` or `'webgl2'`). Browsers lock a <canvas> to the
    // first context type successfully acquired for its lifetime, so
    // when _setRenderer installs a renderer that declares a different
    // contextType we replace the underlying <canvas> element entirely
    // (see _replaceCanvas) so the new renderer's getContext() can
    // succeed. Default 2D — matches what _defaultRenderer.init() does
    // on the freshly-mounted canvas.
    hwState._currentCanvasContextType = '2d';

    // One persistent bundle object per createHighway() instance —
    // _makeBundle() mutates its fields in place each call instead of
    // allocating a fresh ~35-field object per rAF frame (steady GC churn
    // on weak hardware, ×N under splitscreen). Consequences for
    // consumers: the bundle OBJECT's identity is stable across frames
    // and carries no meaning; its field values are only valid for the
    // duration of the current draw call. Array fields (`notes`,
    // `chords`, `handShapes`, `chordTemplates`, ...) still swap
    // reference whenever chart data changes — field-identity caches
    // (e.g. highway_3d's merge caches) rely on that invariant.
    const _bundleReused = {};

    function _makeBundle() {
        // Snapshot of current factory state passed to each renderer call.
        // Arrays and songInfo are LIVE references, not copies — the
        // bundle's `notes`, `chords`, `anchors`, `beats`, etc. point at
        // closure state. Renderers MUST NOT mutate these; treat them as
        // read-only. We don't Object.freeze or deep-copy for per-frame
        // cost reasons.
        const b = _bundleReused;
        // Timing
        b.currentTime = hwState.currentTime;
        b.songInfo = hwState.songInfo;
        b.isReady = hwState.ready;
        // True while the chart clock is actively advancing; false when
        // audio is paused / stalled / mid-seek (setTime has kept getting
        // the same t for > _CHART_MAX_INTERP_MS). This is the same
        // predicate getTime() uses to decide raw-vs-interpolated, and the
        // no-anchor boot state reads as not-playing — matching getTime()
        // returning raw chartTime there. Renderers that run their own
        // sub-frame clock (highway_3d's smoothNow) gate on this to fall
        // back to raw instead of extrapolating forward against a frozen
        // audio sample. Undefined on downlevel hosts → those renderers
        // keep their own staleness-based fallback.
        b.isPlaying = !Number.isNaN(hwState._chartAnchorPerfNow)
            && (performance.now() - hwState._chartLastAdvanceAt) <= _CHART_MAX_INTERP_MS;

        // Chart content (filter-aware — difficulty-filtered arrays
        // preferred; raw arrays are the fallback when no ladder data).
        b.notes = hwState._filteredNotes !== null ? hwState._filteredNotes : hwState.notes;
        b.chords = hwState._filteredChords !== null ? hwState._filteredChords : hwState.chords;
        b.anchors = hwState._filteredAnchors !== null ? hwState._filteredAnchors : hwState.anchors;
        b.beats = hwState.beats;
        b.sections = hwState.sections;
        b.chordTemplates = hwState.chordTemplates;
        b.stringCount = hwState.stringCount;
        // Mirrors song_info tuning capo offsets (±semitones from the
        // instrument’s standard open-string layout). Live reference.
        b.tuning = hwState.songInfo?.tuning;
        b.capo = hwState.songInfo?.capo;
        b.lyrics = hwState.lyrics;
        b.lyricsSource = hwState.lyricsSource;
        b.toneChanges = hwState.toneChanges;
        b.toneBase = hwState.toneBase;
        // Drum tab payload (or null when the active arrangement has
        // no drum_tab). Live reference — renderers MUST treat as
        // read-only. Plugins should prefer this over decoding the
        // standard `notes` stream when present; absence is the
        // signal to fall back to legacy MIDI-encoded drums.
        b.drumTab = hwState.drumTab;

        // Master-difficulty (feedBack#48)
        b.mastery = hwState._mastery;
        b.hasPhraseData = !!(hwState._phrases && hwState._phrases.length > 0);
        // When phrase data authored ANY handshape, respect the filtered
        // list strictly (even when this difficulty leaves it empty) —
        // otherwise low-mastery levels would surface arp hints that
        // don't belong. Only fall back to the flat list when the
        // phrase data carries no handshapes at all (common on DLC
        // where handshapes ship on the arrangement root).
        b.handShapes = (hwState._filteredHandShapes !== null && hwState._phrasesHaveHandShapes)
            ? hwState._filteredHandShapes
            : hwState.handShapes;

        // Display flags
        b.inverted = hwState._inverted;
        b.lefty = hwState._lefty;
        b.renderScale = _effectiveRenderScale();
        b.lyricsVisible = hwState.showLyrics;
        // Teaching marks sd/ch overlay pref (§6.2.2) so custom renderers
        // (e.g. the 3D highway) can mirror the 2D opt-in toggle. The fg
        // finger-hint pref rides alongside (default on, independently hideable).
        b.teachingMarksVisible = hwState._showTeachingMarks;
        b.fingerHintsVisible = hwState._showFingerHints;

        // 2D-style helpers (renderers that don't need these can ignore).
        // `fillTextUnmirrored` is deliberately NOT exposed here —
        // the factory-level version writes to the default renderer's
        // closure ctx, which is null for custom renderers. Renderers
        // that need lefty-aware text should check `bundle.lefty` and
        // apply the mirror transform themselves on their own context.
        b.project = project;
        b.fretX = boundFretX;              // stable, hwState-bound — see the factory head
        // Windowed-iteration helpers (stable references): lower-bound
        // binary searches so custom viz don't full-scan chart arrays per
        // frame. lowerBoundT keys on `.t` (notes / chords); lowerBoundTime
        // keys on `.time` (beats / anchors / sections).
        b.lowerBoundT = bsearch;
        b.lowerBoundTime = bsearchTime;

        // Per-note judgment overlay (feedBack#254). Renderers call
        // this per visible note / chord-note to find out whether a
        // scorer (note_detect) has flagged it hit / actively-held /
        // missed, so the gem itself can light up instead of relying
        // on an overlay ring. Returns null when no provider is set
        // or it reports nothing for this note; otherwise
        // { state: 'hit'|'active'|'miss', alpha: 0..1, color: string|null }.
        b.getNoteState = boundNoteState;   // stable, hwState-bound — see the factory head
        // Lets custom renderers (e.g. highway_3d) tell "is a provider
        // attached" apart from "no provider, getNoteState always
        // returns null" — `getNoteState` always exists on the bundle
        // so its presence alone isn't a useful "detect mode" signal.
        // Renderers gate verdict-window cull / draw extensions on this.
        b.getNoteStateProvider = _getNoteStateProvider; // stable — see above
        return b;
    }

    const _defaultRenderer = {
        _ctxWarned: false,
        init(canvasEl /* , bundle */) {
            // getContext('2d') returns null when the canvas is already
            // locked to another context type (e.g. a WebGL viz plugin
            // grabbed it first). Once that happens the 2D renderer can't
            // recover on the same canvas — surface a single clear error
            // and skip drawing. A future revision will recreate the
            // canvas element on renderer-type swap to avoid this.
            hwState.ctx = canvasEl.getContext('2d');
            if (!hwState.ctx && !this._ctxWarned) {
                console.error(
                    'Default 2D renderer: canvas.getContext("2d") returned null ' +
                    '— the canvas is locked to another context type. ' +
                    'Reload the page to restore the highway.'
                );
                this._ctxWarned = true;
            }
        },
        draw(/* bundle */) {
            // Still reads from the factory closure directly — the bundle
            // is shaped for custom renderers, not used here. Keeping the
            // default renderer's body unchanged from the pre-refactor
            // draw() preserves pixel-level parity with current main.
            if (!hwState.canvas || !hwState.ready || !hwState.ctx) return;
            try {
                const W = hwState.canvas.width;
                const H = hwState.canvas.height;
                hwState.ctx.fillStyle = BG;
                hwState.ctx.fillRect(0, 0, W, H);

                const anchor = getAnchorAt(hwState.currentTime);
                updateSmoothAnchor(anchor, 1 / 60);

                hwState.ctx.save();
                if (hwState._lefty) {
                    hwState.ctx.translate(W, 0);
                    hwState.ctx.scale(-1, 1);
                }

                drawHighway(W, H);
                drawFretLines(W, H);
                drawBeats(W, H);
                drawStrings(W, H);
                drawSustains(W, H);
                drawNowLine(W, H);
                drawNotes(W, H);
                drawChords(W, H);
                drawFretNumbers(W, H);

                // Plugin draw hooks (same coordinate system as the highway).
                // The default 2D renderer iterates the list directly here;
                // custom renderers (e.g. the bundled 3D Highway) invoke
                // `api.fireDrawHooks(ctx, W, H)` against their own overlay
                // 2D context after rendering. Either path receives the
                // same `(ctx, W, H)` callback signature.
                for (const hook of hwState._drawHooks) {
                    try { hook(hwState.ctx, W, H); } catch (e) { /* ignore */ }
                }

                hwState.ctx.restore();

                // Lyrics: drawn unmirrored so lines stay left-to-right readable (layout is center-symmetric)
                if (hwState.showLyrics) drawLyrics(W, H);
            } catch (e) {
                console.error('draw error:', e);
            }
        },
        resize(/* w, h */) {
            // no-op; canvas dimension change is handled by the factory,
            // and the 2D context doesn't maintain persistent state we'd
            // need to rebuild here.
        },
        destroy() {
            // Leave ctx intact. Helper paths like fillTextReadable /
            // api.fillTextUnmirrored may still be called while another
            // renderer is active or after stop() (e.g. a residual draw
            // hook, plugin cleanup code). Forcing ctx to null would
            // make those calls throw. A subsequent init() re-assigns
            // ctx via canvasEl.getContext('2d') — the browser returns
            // the same cached context for the same canvas, so there's
            // nothing to "refresh" by nulling. Reset the warn-once
            // guard so a fresh init on a fresh canvas is a new
            // opportunity to succeed or fail.
            this._ctxWarned = false;
        },
    };

    // Tracks consecutive renderer.draw failures so a permanently broken
    // renderer auto-reverts to default instead of spamming the console
    // every frame. Reset on every successful draw and whenever a new
    // renderer is installed.
    hwState._rendererDrawFailures = 0;
    // True only while the current renderer has had a successful init
    // since its last destroy (or was freshly installed but never init'd
    // because canvas was null). Gates destroy calls so an uninit'd
    // renderer doesn't receive spurious destroys — the restore-on-
    // page-load flow relies on this: setRenderer can run before init.
    hwState._rendererInited = false;

    function _destroyCurrentIfInited() {
        if (hwState._renderer && hwState._rendererInited && typeof hwState._renderer.destroy === 'function') {
            try { hwState._renderer.destroy(); }
            catch (e) { console.error('renderer destroy:', e); }
        }
        hwState._rendererInited = false;
    }

    function _emitVizReverted(reason) {
        // Notify listeners (e.g. app.js's viz picker, splitscreen's
        // per-panel picker in Wave C) that the factory auto-reverted
        // to the default renderer — so the UI / persisted selection
        // don't keep advertising the broken plugin.
        if (window.feedBack && typeof window.feedBack.emit === 'function') {
            try { window.feedBack.emit('viz:reverted', { reason }); }
            catch (e) { console.error('viz:reverted emit:', e); }
        }
    }

    function _emitVizReady() {
        // Notify listeners that the custom renderer has fully initialised
        // and is actively drawing (its sync init returned, or its async
        // readyPromise resolved).  App.js uses this to update the Auto
        // closed-state label only once the renderer is confirmed active.
        if (window.feedBack && typeof window.feedBack.emit === 'function') {
            try { window.feedBack.emit('viz:renderer:ready', {}); }
            catch (e) { console.error('viz:renderer:ready emit:', e); }
        }
    }

    // Resolve the contextType a renderer expects on the canvas before
    // its init() runs. Renderer factories may also declare
    // `factory.contextType = 'webgl2'` so app.js reads it without
    // constructing the renderer (used in Auto-mode evaluation to gate
    // WebGL2 renderers on _canRun3D()); here we receive the instance,
    // so we read the field off the instance itself. Absent → '2d'. The
    // built-in default renderer is always '2d'.
    function _resolveRendererContextType(r) {
        if (r === _defaultRenderer) return '2d';
        if (r && typeof r.contextType === 'string' && r.contextType) {
            return r.contextType;
        }
        return '2d';
    }

    // Logical identity of a renderer for swap detection: its viz id, not
    // its object reference. app.js stamps `pluginId`/`source` (the viz
    // picker id) onto every renderer it installs via _tagVizRenderer, and
    // setViz()/_autoMatchViz() build a FRESH renderer object with factory()
    // on every (re)apply — even when the selected viz did not change (e.g.
    // Auto re-resolving to the same viz across consecutive songs). Keying
    // the canvas-replacement decision on object identity would therefore
    // treat those benign re-installs as a swap and needlessly clone
    // #highway, dropping listeners/expando state attached to the element.
    // The default renderer has no id, so it keys on its own singleton; an
    // untagged custom renderer falls back to its object reference (the safe
    // "treat as a swap" answer).
    function _rendererVizKey(r) {
        if (r === _defaultRenderer) return _defaultRenderer;
        return (r && (r.pluginId || r.source)) || r;
    }

    // Replace the underlying <canvas> element with a fresh one because
    // the next renderer needs a different context type than the current
    // canvas is locked to. Preserves the DOM position, id, classes,
    // data-* attributes, and inline style cssText so the surrounding
    // layout (CSS selectors, sibling overlays, splitscreen panels) is
    // unaffected. Plugins that re-query `getElementById('highway')`
    // lazily inside their own event handlers automatically pick up the
    // new element; longer-lived references can listen for the
    // `highway:canvas-replaced` event emitted at the end.
    function _replaceCanvas(newType) {
        if (!hwState.canvas) return;
        const oldCanvas = hwState.canvas;
        // cloneNode(false) preserves the element type and ALL HTML
        // attributes (id, class, style, data-*, aria-*, role, tabindex,
        // width/height attribute form, plus anything else a plugin
        // attached) without copying children — exactly what we need.
        // It does NOT copy event listeners or expando properties set
        // imperatively on the JS object (like `canvas._myCtx = gl` or
        // any plugin-attached data), so any bound rendering context is
        // left behind on the detached element — which is what allows the
        // new canvas to start fresh and accept a different getContext()
        // call. Note: canvas.width/height ARE reflected as HTML
        // attributes, so those values DO survive the clone; api.resize()
        // below re-applies the backing-store dimensions anyway.
        const newCanvas = oldCanvas.cloneNode(false);
        // Swap in place so siblings, parents, and document order all
        // stay intact. replaceWith() detaches the old node from the DOM.
        oldCanvas.replaceWith(newCanvas);
        hwState.canvas = newCanvas;
        // The default renderer caches its 2D context in the factory
        // closure (`ctx`). The old reference now points at a detached
        // canvas — null it so any straggling draw paths short-circuit
        // instead of painting into the void. The next default-renderer
        // init() will re-acquire `ctx` from the new canvas via
        // getContext('2d') (succeeds because the new element is fresh).
        hwState.ctx = null;
        // Re-size the new element to match the current container —
        // sets style.width/height and the backing-store width/height.
        // _renderer.resize is gated on _rendererInited, which has just
        // been cleared by _destroyCurrentIfInited, so api.resize()
        // here is a pure dimension update on the new element; the
        // renderer's own resize fires after init completes.
        try { api.resize(); }
        catch (e) { console.error('resize after canvas replace:', e); }
        hwState._currentCanvasContextType = newType;
        // The visibility cache is per-canvas-instance: a freshly
        // attached canvas could be in a different displayed state
        // than the one it replaced, and _lastVisible would otherwise
        // suppress the first transition. Reset to null so the next
        // rAF tick re-emits unconditionally.
        hwState._lastVisible = null;
        hwState._domVisSampledFrame = NaN; // fresh canvas → fresh DOM sample
        // Defensive notify for plugins / overlays that cache the
        // canvas element across events. Lazy lookups via
        // getElementById('highway') do not need this — they'll pick
        // up the new element on their next call.
        if (window.feedBack && typeof window.feedBack.emit === 'function') {
            try {
                window.feedBack.emit('highway:canvas-replaced', {
                    oldCanvas, newCanvas, contextType: newType,
                });
            } catch (e) { console.error('highway:canvas-replaced emit:', e); }
        }
    }

    function _setRenderer(r) {
        // Capture the outgoing renderer before _destroyCurrentIfInited /
        // the `_renderer = next` assignment below overwrite it — the
        // canvas-replacement decision needs to know whether we're
        // actually swapping to a *different* renderer instance.
        const prev = hwState._renderer;
        _destroyCurrentIfInited();
        // null/undefined reverts to default. Anything else must provide
        // at minimum a draw(bundle) function — without it the rAF loop
        // would throw every frame. Log once and fall back to default
        // rather than accepting a broken renderer.
        let next;
        if (r == null) {
            next = _defaultRenderer;
        } else if (typeof r.draw === 'function') {
            next = r;
        } else {
            console.error('setRenderer: renderer missing draw(bundle) function; reverting to default.');
            next = _defaultRenderer;
        }
        hwState._renderer = next;
        hwState._rendererDrawFailures = 0;
        // Defer init/resize until the canvas is available. setRenderer
        // can legitimately be called before api.init() runs (e.g. app.js
        // restoring a saved picker selection at page load, before any
        // song has been played). api.init() will re-run these when it
        // assigns the canvas.
        if (!hwState.canvas) return;
        // Browsers lock a <canvas> to the first context type
        // successfully acquired for its lifetime: once getContext('2d')
        // succeeds, getContext('webgl2') on the same element returns
        // null, and vice versa. When the renderer being installed
        // declares a different context type than the one already bound,
        // swap in a fresh <canvas> so the new renderer's init() can
        // acquire its context cleanly. Previous renderer was already
        // destroyed by _destroyCurrentIfInited above, so it's safe to
        // detach the element from the DOM here.
        const nextType = _resolveRendererContextType(next);
        // Replace the underlying <canvas> when (a) the new renderer needs
        // a different context type than the one currently bound, OR (b)
        // we're swapping to a *different* visualization while keeping the
        // same context type. Case (b) prevents a stale frame from the
        // previous renderer bleeding through: renderers that draw into a
        // sibling overlay (e.g. 3D Highway's `.h3d-wrap`) never paint
        // #highway, so whatever the *previous* renderer left on the shared
        // canvas would otherwise stay visible in any area the overlay does
        // not cover. The reported symptom was the 3D drum highway (which
        // renders directly onto #highway) showing through the gap below
        // the 3D guitar highway's overlay after switching between them —
        // both are webgl2, so the type-change check alone never fired. A
        // fresh canvas starts blank/transparent, so the incoming renderer
        // always begins over a clean surface. The swap test keys on the
        // viz id (_rendererVizKey), NOT object identity: setViz/_autoMatchViz
        // build a fresh renderer object on every apply, so an object-identity
        // check would clone #highway on every benign same-viz re-install
        // (e.g. Auto re-resolving to the same viz across songs) and drop the
        // element's listeners/expando state. Skipped when re-installing the
        // same viz, and on the very first install (prev === null) where
        // there is no prior frame to clear.
        const _vizChanged = prev && _rendererVizKey(next) !== _rendererVizKey(prev);
        if (nextType !== hwState._currentCanvasContextType || _vizChanged) {
            _replaceCanvas(nextType);
        }
        const bundle = _makeBundle();
        // A renderer without an init() function is treated as ready
        // by default (it simply has no setup to do). If an init()
        // exists, only flip the flag true when it returns without
        // throwing — otherwise a later destroy would run on an
        // effectively-uninitialized renderer.
        let initSucceeded = typeof hwState._renderer.init !== 'function';
        if (typeof hwState._renderer.init === 'function') {
            try {
                hwState._renderer.init(hwState.canvas, bundle);
                initSucceeded = true;
            }
            catch (e) {
                console.error('renderer init:', e);
                // Init may have partially allocated GPU/DOM resources
                // before throwing. Run destroy best-effort to release
                // whatever it got — renderer's destroy contract already
                // requires handling partial state gracefully. Then
                // revert to the default renderer so the user isn't
                // stranded on a broken viz, and notify the UI so the
                // picker + localStorage sync back to 'default'.
                if (hwState._renderer !== _defaultRenderer) {
                    if (typeof hwState._renderer.destroy === 'function') {
                        try { hwState._renderer.destroy(); }
                        catch (destroyErr) {
                            console.error('renderer destroy after init failure:', destroyErr);
                        }
                    }
                    hwState._renderer = _defaultRenderer;
                    _emitVizReverted('init-failure');
                    // The just-failed renderer may have already
                    // acquired its (non-2D) context on the canvas
                    // before throwing, locking the element to that
                    // context type. Default renderer is 2D — swap in
                    // a fresh canvas so its getContext('2d') succeeds.
                    if (hwState._currentCanvasContextType !== '2d') {
                        _replaceCanvas('2d');
                    }
                    if (typeof hwState._renderer.init === 'function') {
                        try {
                            hwState._renderer.init(hwState.canvas, _makeBundle());
                            initSucceeded = true;
                        }
                        catch (e2) {
                            console.error('default renderer init after revert:', e2);
                        }
                    } else {
                        initSucceeded = true;
                    }
                }
            }
        }
        hwState._rendererInited = initSucceeded;
        if (!hwState._rendererInited) return;
        if (typeof hwState._renderer.resize === 'function') {
            try { hwState._renderer.resize(hwState.canvas.width, hwState.canvas.height); }
            catch (e) { console.error('renderer resize:', e); }
        }
        // Optional async-ready contract: if the renderer exposes a
        // `readyPromise`, it initialises asynchronously and the promise
        // settles when the renderer is actually drawing (resolve) or has
        // failed without throwing during sync init (reject).
        // On resolve  → emit viz:renderer:ready so the UI can reflect the
        //               confirmed active renderer.
        // On reject   → revert to default, emit viz:reverted (same path as
        //               a sync init failure) so the UI and Auto label sync.
        // If readyPromise is absent the sync init was all there was to do;
        // emit viz:renderer:ready immediately.
        const _installedRenderer = hwState._renderer;
        if (_installedRenderer !== _defaultRenderer) {
            const rp = _installedRenderer.readyPromise;
            if (rp && typeof rp.then === 'function') {
                // Named handler for the rejection path so the async error
                // contract is readable at a glance without unwrapping a long
                // inline arrow function.
                function _handleAsyncInitFailure(e) {
                    if (hwState._renderer !== _installedRenderer) return;
                    console.error('renderer async init failure:', e);
                    _destroyCurrentIfInited();
                    hwState._renderer = _defaultRenderer;
                    hwState._rendererDrawFailures = 0;
                    _emitVizReverted('async-init-failure');
                    if (hwState.canvas) {
                        // Async-init failure usually means the renderer
                        // got far enough to acquire its (non-2D) context
                        // before rejecting — the canvas is locked to
                        // that type. Reverting to the 2D default
                        // requires a fresh canvas element.
                        if (hwState._currentCanvasContextType !== '2d') {
                            _replaceCanvas('2d');
                        }
                        let defInitOk = typeof _defaultRenderer.init !== 'function';
                        if (typeof _defaultRenderer.init === 'function') {
                            try {
                                _defaultRenderer.init(hwState.canvas, _makeBundle());
                                defInitOk = true;
                            } catch (e2) {
                                console.error('default renderer init after async revert:', e2);
                            }
                        }
                        hwState._rendererInited = defInitOk;
                        if (hwState._rendererInited && typeof _defaultRenderer.resize === 'function') {
                            try { _defaultRenderer.resize(hwState.canvas.width, hwState.canvas.height); }
                            catch (e2) { console.error('default renderer resize after async revert:', e2); }
                        }
                    }
                }
                rp.then(
                    () => { if (hwState._renderer === _installedRenderer) _emitVizReady(); },
                    _handleAsyncInitFailure
                );
            } else {
                _emitVizReady();
            }
        }
    }

    // Visibility check (#246). offsetParent === null catches display:none
    // on the canvas OR any ancestor — the splitscreen case. Doesn't
    // catch visibility:hidden / opacity:0 / off-screen transforms;
    // hosts that need those use setVisible() instead.
    function _isHighwayVisible() {
        if (hwState._visibleOverride !== null) return hwState._visibleOverride;
        // Throttled offsetParent read — see _DOM_VIS_CHECK_FRAMES above.
        if (Number.isNaN(hwState._domVisSampledFrame)
            || ((hwState._frameIdx - hwState._domVisSampledFrame) | 0) >= _DOM_VIS_CHECK_FRAMES
            || ((hwState._frameIdx - hwState._domVisSampledFrame) | 0) < 0) {
            hwState._domVisCached = !!(hwState.canvas && hwState.canvas.offsetParent !== null);
            hwState._domVisSampledFrame = hwState._frameIdx;
        }
        return hwState._domVisCached;
    }

    // Emit only on transition so renderer-side listeners aren't woken
    // every frame. The first call after init emits a transition from
    // null → boolean — that's the documented contract: "fired on
    // transitions including the first one."
    function _emitVisibilityIfChanged() {
        const v = _isHighwayVisible();
        if (v === hwState._lastVisible) return;
        hwState._lastVisible = v;
        if (typeof window !== 'undefined'
            && window.feedBack
            && typeof window.feedBack.emit === 'function') {
            window.feedBack.emit('highway:visibility', { visible: v, canvas: hwState.canvas });
        }
    }

    // Scale actually applied to the canvas + bundle.renderScale: the
    // user's manual ceiling times the load-adaptive factor, floored so a
    // pathological GPU can't drive it to zero. (#654)
    function _effectiveRenderScale() {
        // Sanitize each factor independently so one corrupt value doesn't
        // silently force full-res (which would ignore a valid manual ceiling)
        // or propagate NaN into canvas sizing.
        const user = Number.isFinite(hwState._renderScale) ? hwState._renderScale : 1;
        const auto = Number.isFinite(hwState._autoScale) ? hwState._autoScale : 1;
        // The adaptive floor can't exceed the user's manual ceiling — a minimum
        // resolution higher than the chosen maximum makes no sense — so clamp the
        // floor to `user` and never let the effective scale rise above the
        // ceiling (preserves the "Quality is the cap" semantics).
        const floor = Math.min(hwState._autoScaleMin, user);
        return Math.min(user, Math.max(floor, user * auto));
    }

    // Called once per drawn frame during active playback with the measured
    // cost of _renderer.draw(). Smooths the cost (EMA) and, on a cooldown,
    // nudges _autoScale down when the renderer blows the per-frame budget
    // and back up when it has headroom. A change re-applies via api.resize()
    // — the same path manual setRenderScale uses. (#654)
    function _adaptRenderScale(drawMs) {
        hwState._drawMsEMA = hwState._drawMsEMA === 0 ? drawMs : hwState._drawMsEMA * 0.9 + drawMs * 0.1;
        const nowP = performance.now();
        if (nowP - hwState._lastAutoAdjustAt < _AUTO_ADJUST_COOLDOWN_MS) return;
        // Commit to one evaluation per cooldown regardless of outcome —
        // otherwise, once the cooldown elapses, the deadband branch below
        // would re-run this comparison every frame on the hot path.
        hwState._lastAutoAdjustAt = nowP;
        const eff = _effectiveRenderScale();
        let next = hwState._autoScale;
        if (hwState._drawMsEMA > _DRAW_BUDGET_HI_MS && eff > hwState._autoScaleMin) {
            // Over budget — downscale promptly to protect the frame rate, and reset
            // the upscale clock so we don't immediately bounce back up.
            next = hwState._autoScale * 0.85;
            hwState._lastUpscaleAt = nowP;
        } else if (hwState._drawMsEMA < _DRAW_BUDGET_LO_MS && eff < 1
                   && nowP - hwState._lastUpscaleAt >= _AUTO_UPSCALE_COOLDOWN_MS) {
            // Headroom — upscale LAZILY: a smaller step on a longer cooldown, and
            // only when the projected cost AFTER the step (cost scales ~with the
            // pixel count, i.e. step²) still clears the high budget. That predictive
            // guard is what stops the up→over-budget→down ping-pong testers saw: the
            // scale settles just inside the deadband instead of oscillating across it.
            const step = 1.06;
            if (hwState._drawMsEMA * step * step < _DRAW_BUDGET_HI_MS) {
                next = hwState._autoScale * step;
                hwState._lastUpscaleAt = nowP;
            }
        }
        // Clamp so _renderScale * _autoScale stays within [_autoScaleMin, 1].
        // Cap `lo` at 1: when the floor exceeds the manual ceiling (e.g. quality
        // 0.5 + floor 1.0) the raw ratio is > 1, which would otherwise push
        // _autoScale above 1 and break the "auto is a [0,1] multiplier" invariant.
        const lo = hwState._renderScale > 0 ? Math.min(1, hwState._autoScaleMin / hwState._renderScale) : 1;
        next = Math.max(lo, Math.min(1, next));
        if (Math.abs(next - hwState._autoScale) < 0.01) return;
        hwState._autoScale = next;
        try { api.resize(); } catch (e) { /* resize is best-effort */ }
    }

    // Optional on-screen perf readout (#654), gated on
    // localStorage.highwayPerfHud === '1'. Lets a reporter confirm the
    // adaptive cap is holding without opening devtools. No-op (and tears
    // down any existing HUD) when the flag is off.
    function _updatePerfHud() {
        if (typeof document === 'undefined' || !document.body) return;
        const nowP = performance.now();
        // Re-read the debug-only flag at most ~2x/sec, not every frame:
        // localStorage access is synchronous and this is on the rAF hot path.
        if (nowP - hwState._hudFlagAt > 500) {
            hwState._hudFlagAt = nowP;
            try { hwState._hudOn = localStorage.getItem('highwayPerfHud') === '1'; } catch (_) { hwState._hudOn = false; }
        }
        if (!hwState._hudOn) {
            if (hwState._perfHud) { hwState._perfHud.remove(); hwState._perfHud = null; }
            return;
        }
        if (hwState._lastFramePerf) {
            const d = nowP - hwState._lastFramePerf;
            hwState._frameMsEMA = hwState._frameMsEMA === 0 ? d : hwState._frameMsEMA * 0.9 + d * 0.1;
        }
        hwState._lastFramePerf = nowP;
        if (!hwState._perfHud) {
            hwState._perfHud = document.createElement('div');
            // Class, not a fixed id: multiple createHighway() instances
            // (splitscreen) would otherwise mint duplicate #ids — invalid
            // HTML. We hold the element by reference (_perfHud), not lookup.
            hwState._perfHud.className = 'highway-perf-hud';
            hwState._perfHud.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;' +
                'font:11px/1.4 monospace;background:rgba(0,0,0,.7);color:#0f0;' +
                'padding:4px 6px;border-radius:4px;pointer-events:none;white-space:pre;';
            document.body.appendChild(hwState._perfHud);
        }
        const fps = hwState._frameMsEMA > 0 ? 1000 / hwState._frameMsEMA : 0;
        hwState._perfHud.textContent =
            'fps ' + fps.toFixed(0) +
            '  draw ' + hwState._drawMsEMA.toFixed(1) + 'ms' +
            '  scale ' + _effectiveRenderScale().toFixed(2) +
            ' (user ' + hwState._renderScale.toFixed(2) + ' / auto ' + hwState._autoScale.toFixed(2) + ')';
    }

    function draw() {
        hwState.animFrame = requestAnimationFrame(draw);
        if (!hwState.canvas || !hwState._renderer) return;
        hwState._frameIdx = (hwState._frameIdx + 1) | 0;
        // Visibility-aware skip (#246). Run BEFORE the !ready bail so
        // hide/show transitions during the loading / reconnect window
        // still propagate to listeners (a splitscreen-driven hide that
        // straddles a song change would otherwise leave 3D Highway's
        // overlay visible across the not-ready frames).
        _emitVisibilityIfChanged();
        // Decide once whether this frame renders, and reuse it for both the
        // perf-HUD reset and the draw gate. `_lastVisible` going false has two
        // distinct causes that differ for a CUSTOM renderer painting its own
        // surface (feedBack#819):
        //   • override-hide (`_visibleOverride === false`) — a renderer called
        //     `setVisible(false)` because an opaque overlay covers the
        //     *canvas*. The `highway:visibility` event already fired above so
        //     sibling overlay renderers (3D Highway's `.h3d-wrap`) pause their
        //     own loops, but the ACTIVE custom renderer that triggered it is
        //     still painting its own visible surface (e.g. Tab View's alphaTab
        //     DOM over the hidden canvas) and must keep getting draw(). The
        //     default 2D renderer — whose canvas IS the occluded surface — is
        //     not exempted.
        //   • genuine off-screen (`canvas.offsetParent === null`) — navigate-
        //     away or a `display:none` splitscreen panel. Nothing is on
        //     screen, so pause everything (#246/#654) even an active custom
        //     renderer, even if an override-hide is also in effect.
        // Previously the gate was a bare `if (!_lastVisible) return`, which
        // starved an active custom renderer's draw() on an override-hide — the
        // Tab View cursor froze in single-player (feedBack#734).
        let _rendering = hwState._lastVisible;
        if (!_rendering
            && hwState._visibleOverride === false
            && hwState._renderer !== _defaultRenderer
            && hwState.canvas && hwState.canvas.offsetParent !== null) {
            _rendering = true;
        }
        // Don't let the debug HUD strand on screen while we're not actively
        // rendering (hidden, or WS not ready). It re-creates next frame once
        // rendering resumes and the flag is still on. (#654)
        if (hwState._perfHud && (!_rendering || !hwState.ready)) { hwState._perfHud.remove(); hwState._perfHud = null; }
        if (!_rendering) return;
        // Match pre-refactor behaviour: skip draw until WS ready fires.
        // This gates out the brief "arrays cleared, WS reconnecting"
        // window during playSong / reconnect. Renderers that want to
        // draw a loading state can still opt in via the `isReady`
        // field on the bundle passed to a custom pre-ready handler —
        // we'd need to widen the contract to support that, out of
        // scope here. Default 2D renderer also checks `ready` in its
        // draw body (defence in depth).
        if (!hwState.ready) return;
        // Playback-aware throttle (#654). Reuse getTime()'s pause
        // signal: once an anchor exists, chartTime not advancing for
        // > _CHART_MAX_INTERP_MS means audio is paused/stalled (the
        // 60 Hz tick in app.js keeps calling setTime() with the same t
        // while paused). While paused, draw at most once per
        // _PAUSED_FRAME_INTERVAL_MS so a heavy WebGL renderer stops
        // pinning the GPU re-rendering a static frame. Active playback
        // (clock advancing) is never throttled.
        let _paused = false;
        if (!Number.isNaN(hwState._chartAnchorPerfNow)) {
            const _nowP = performance.now();
            if (_nowP - hwState._chartLastAdvanceAt > _CHART_MAX_INTERP_MS) {
                _paused = true;
                if (_nowP - hwState._lastPausedDrawAt < _PAUSED_FRAME_INTERVAL_MS) return;
                hwState._lastPausedDrawAt = _nowP;
            }
        }
        // Skip bundle allocation when the default renderer is active —
        // it reads closure state directly and ignores the bundle.
        // _makeBundle at 60fps was a steady GC churn for the common
        // case where no custom renderer is installed.
        const bundle = hwState._renderer === _defaultRenderer ? undefined : _makeBundle();
        try {
            const _drawStart = performance.now();
            hwState._renderer.draw(bundle);
            hwState._rendererDrawFailures = 0;
            // Adaptive render-scale (#654): only adapt during active
            // playback — paused frames are throttled above, so their
            // timing isn't representative of the playback workload.
            if (!_paused) _adaptRenderScale(performance.now() - _drawStart);
            _updatePerfHud();
        } catch (e) {
            hwState._rendererDrawFailures += 1;
            console.error('renderer draw:', e);
            // Self-heal: a plugin whose draw() throws every frame
            // would otherwise spam the console and leave the canvas
            // blank indefinitely. After a short streak of failures,
            // revert to the built-in renderer so the user at least
            // gets the default highway back. 2D default is known-safe.
            if (hwState._rendererDrawFailures >= MAX_RENDERER_DRAW_FAILURES &&
                hwState._renderer !== _defaultRenderer) {
                console.error(
                    'renderer draw: failed ' + hwState._rendererDrawFailures +
                    ' frames in a row; reverting to default renderer.'
                );
                _setRenderer(_defaultRenderer);
                _emitVizReverted('draw-failure');
            }
        }
    }

    function drawHighway(W, H) {
        const strips = 40;
        for (let i = 0; i < strips; i++) {
            const t0 = (i / strips) * VISIBLE_SECONDS;
            const t1 = ((i + 1) / strips) * VISIBLE_SECONDS;
            const p0 = project(t0), p1 = project(t1);
            if (!p0 || !p1) continue;

            const hw0 = W * 0.26 * p0.scale;
            const hw1 = W * 0.26 * p1.scale;
            const bright = 18 + 10 * p0.scale;

            hwState.ctx.fillStyle = `rgb(${bright|0},${bright|0},${(bright+14)|0})`;
            hwState.ctx.beginPath();
            hwState.ctx.moveTo(W/2 - hw0, p0.y * H);
            hwState.ctx.lineTo(W/2 + hw0, p0.y * H);
            hwState.ctx.lineTo(W/2 + hw1, p1.y * H);
            hwState.ctx.lineTo(W/2 - hw1, p1.y * H);
            hwState.ctx.fill();
        }
    }

    function drawFretLines(W, H) {
        const pad = 3;
        const lo = 0;
        const hi = Math.ceil(hwState.displayMaxFret);
        hwState.ctx.strokeStyle = '#2d2d45';
        hwState.ctx.lineWidth = 1;

        for (let fret = lo; fret <= hi; fret++) {
            if (fret < 0) continue;
            hwState.ctx.beginPath();
            for (let i = 0; i <= 40; i++) {
                const t = (i / 40) * VISIBLE_SECONDS;
                const p = project(t);
                if (!p) continue;
                const x = fretX(hwState, fret, p.scale, W);
                if (i === 0) hwState.ctx.moveTo(x, p.y * H);
                else hwState.ctx.lineTo(x, p.y * H);
            }
            hwState.ctx.stroke();
        }
    }

    function drawBeats(W, H) {
        // Window the beat scan — a long song carries thousands of beats
        // and iterating (and projecting) all of them per frame was pure
        // waste; project() culling stays as the safety net.
        const lo = bsearchTime(hwState.beats, hwState.currentTime - 0.25);
        const hi = bsearchTime(hwState.beats, hwState.currentTime + VISIBLE_SECONDS + 0.25);
        for (let i = lo; i < hi; i++) {
            const beat = hwState.beats[i];
            const tOff = beat.time - hwState.currentTime;
            const p = project(tOff);
            if (!p || p.scale < 0.06) continue;
            const hw = W * 0.26 * p.scale;
            const isMeasure = beat.measure >= 0;
            hwState.ctx.strokeStyle = isMeasure ? '#343450' : '#202038';
            hwState.ctx.lineWidth = isMeasure ? 2 : 1;
            hwState.ctx.beginPath();
            hwState.ctx.moveTo(W/2 - hw, p.y * H);
            hwState.ctx.lineTo(W/2 + hw, p.y * H);
            hwState.ctx.stroke();
        }
    }

    function drawStrings(W, H) {
        const strTop = H * 0.83;
        const strBot = H * 0.95;
        const margin = W * 0.03;
        // Adapt to the active arrangement's string count: 4 for bass,
        // 6 for guitar, 7+ for extended-range GP imports. The visible
        // band [strTop..strBot] gets divided into (stringCount - 1)
        // slots, so 4 strings spread across the full band rather than
        // using the upper 4/6ths of the 6-string layout. The Math.max
        // guards against a hypothetical 1-string instrument (denom=0).
        const span = Math.max(1, hwState.stringCount - 1);
        for (let i = 0; i < hwState.stringCount; i++) {
            const yi = hwState._inverted ? (hwState.stringCount - 1 - i) : i;
            const y = strTop + (yi / span) * (strBot - strTop);
            hwState.ctx.strokeStyle = hwState.STRING_COLORS[i] || '#888';
            hwState.ctx.lineWidth = 3;
            hwState.ctx.beginPath();
            hwState.ctx.moveTo(margin, y);
            hwState.ctx.lineTo(W - margin, y);
            hwState.ctx.stroke();
        }
    }

    function drawNowLine(W, H) {
        const y = H * 0.82;
        const hw = W * 0.26;
        // Glow
        for (let i = 1; i < 5; i++) {
            const a = Math.max(0, 70 - i * 15);
            hwState.ctx.strokeStyle = `rgba(${a},${a},${a+8},1)`;
            hwState.ctx.lineWidth = 1;
            hwState.ctx.beginPath();
            hwState.ctx.moveTo(W/2 - hw, y - i);
            hwState.ctx.lineTo(W/2 + hw, y - i);
            hwState.ctx.stroke();
            hwState.ctx.beginPath();
            hwState.ctx.moveTo(W/2 - hw, y + i);
            hwState.ctx.lineTo(W/2 + hw, y + i);
            hwState.ctx.stroke();
        }
        hwState.ctx.strokeStyle = '#dce0f0';
        hwState.ctx.lineWidth = 2;
        hwState.ctx.beginPath();
        hwState.ctx.moveTo(W/2 - hw, y);
        hwState.ctx.lineTo(W/2 + hw, y);
        hwState.ctx.stroke();
    }

    function drawNote(W, H, x, y, scale, string, fret, opts, ns) {
        // ns (feedBack#254): normalized judgment state from _noteState,
        // or null/undefined. `lit` means render the gem in the bright
        // string colour with an additive halo; a miss gets a faint red
        // wash instead. ns absent → byte-for-byte the original render.
        const lit = !!(ns && ns.state !== 'miss');
        const isHarmonic = opts?.hm || opts?.hp || false;
        const isPinchHarmonic = opts?.hp || false;
        const isChord = opts?.chord || false;
        const bend = opts?.bn || 0;
        const slide = opts?.sl ?? -1;  // pitched slide-to fret (-1 = none; 0 = slide to open)
        const slu = opts?.slu ?? -1;   // unpitched slide-to fret (-1 = none)
        const hammerOn = opts?.ho || false;
        const pullOff = opts?.po || false;
        const tap = opts?.tp || false;
        const palmMute = opts?.pm || false;
        const tremolo = opts?.tr || false;
        const accent = opts?.ac || false;
        const sz = Math.max(12, 80 * scale * (H / 900));
        const half = sz / 2;
        // When lit, bump the body one step brighter and the backing-glow
        // one step up from STRING_DIM, so even shapes that don't get the
        // _paintGemGlow halo (the open-string bar) read as "lit".
        const color = lit ? (ns.color || hwState.STRING_BRIGHT[string] || hwState.STRING_COLORS[string] || '#888') : (hwState.STRING_COLORS[string] || '#888');
        const dark = lit ? (hwState.STRING_COLORS[string] || '#666') : (hwState.STRING_DIM[string] || '#222');

        if (sz < 6) {
            hwState.ctx.fillStyle = color;
            hwState.ctx.beginPath();
            hwState.ctx.arc(x, y, 2, 0, Math.PI * 2);
            hwState.ctx.fill();
            return;
        }

        // Open string: wide bar spanning the highway (only for standalone notes)
        if (fret === 0 && !isChord) {
            const hw = W * 0.26 * scale;
            const barH = Math.max(6, sz * 0.45);
            // Shadow
            hwState.ctx.fillStyle = dark;
            roundRect(hwState.ctx, W/2 - hw - 1, y - barH/2 - 1, hw * 2 + 2, barH + 2, 3);
            hwState.ctx.fill();
            // Body
            hwState.ctx.fillStyle = color;
            roundRect(hwState.ctx, W/2 - hw, y - barH/2, hw * 2, barH, 2);
            hwState.ctx.fill();
            // Judgment glow (feedBack#254) — central halo on the bar.
            // _paintGemGlow takes a half-extent; barH is the full bar height.
            _paintGemGlow(hwState, W/2, y, barH * 0.5, string, ns);
            // "0" label
            const fontSize = Math.max(8, sz * 0.5) | 0;
            hwState.ctx.fillStyle = '#fff';
            hwState.ctx.font = `bold ${fontSize}px sans-serif`;
            hwState.ctx.textAlign = 'center';
            hwState.ctx.textBaseline = 'middle';
            fillTextReadable(hwState, '0', W/2, y);

            // Technique labels on open strings — PM, H/P/T, tremolo, and
            // accent markers are all meaningful on fret 0. Bend and slide
            // are omitted because they reference a fret position that the
            // centered bar doesn't visually convey. Matches the sz<14 gate
            // the fretted path uses so labels don't render on tiny bars.
            // Fixes #21.
            if (sz >= 14) {
                // H / P / T above
                if (hammerOn || pullOff || tap) {
                    const label = tap ? 'T' : (hammerOn ? 'H' : 'P');
                    hwState.ctx.fillStyle = '#fff';
                    hwState.ctx.font = `bold ${Math.max(9, sz * 0.3) | 0}px sans-serif`;
                    hwState.ctx.textAlign = 'center';
                    hwState.ctx.textBaseline = 'bottom';
                    fillTextReadable(hwState, label, W/2, y - barH/2 - 4);
                }
                // PM below
                if (palmMute) {
                    hwState.ctx.fillStyle = '#aaa';
                    hwState.ctx.font = `bold ${Math.max(8, sz * 0.25) | 0}px sans-serif`;
                    hwState.ctx.textAlign = 'center';
                    hwState.ctx.textBaseline = 'top';
                    fillTextReadable(hwState, 'PM', W/2, y + barH/2 + 2);
                }
                // Tremolo (wavy line above)
                if (tremolo) {
                    const ty = y - barH/2 - 6;
                    hwState.ctx.strokeStyle = '#ff0';
                    hwState.ctx.lineWidth = 1.5;
                    hwState.ctx.beginPath();
                    for (let i = -3; i <= 3; i++) {
                        const wx = W/2 + i * sz * 0.08;
                        const wy = ty + Math.sin(i * 2) * 3;
                        if (i === -3) hwState.ctx.moveTo(wx, wy);
                        else hwState.ctx.lineTo(wx, wy);
                    }
                    hwState.ctx.stroke();
                }
                // Accent caret above
                if (accent) {
                    const ay2 = y - barH/2 - 4;
                    hwState.ctx.strokeStyle = '#fff';
                    hwState.ctx.lineWidth = 2;
                    hwState.ctx.beginPath();
                    hwState.ctx.moveTo(W/2 - sz * 0.2, ay2 + 3);
                    hwState.ctx.lineTo(W/2, ay2 - 2);
                    hwState.ctx.lineTo(W/2 + sz * 0.2, ay2 + 3);
                    hwState.ctx.stroke();
                }
            }
            return;
        }

        if (isHarmonic) {
            // Diamond shape for harmonics
            const dh = half * 1.15;
            // Glow
            hwState.ctx.fillStyle = dark;
            hwState.ctx.beginPath();
            hwState.ctx.moveTo(x, y - dh - 3); hwState.ctx.lineTo(x + half + 3, y);
            hwState.ctx.lineTo(x, y + dh + 3); hwState.ctx.lineTo(x - half - 3, y);
            hwState.ctx.closePath(); hwState.ctx.fill();
            // Body
            hwState.ctx.fillStyle = color;
            hwState.ctx.beginPath();
            hwState.ctx.moveTo(x, y - dh); hwState.ctx.lineTo(x + half, y);
            hwState.ctx.lineTo(x, y + dh); hwState.ctx.lineTo(x - half, y);
            hwState.ctx.closePath(); hwState.ctx.fill();
            // Bright outline
            hwState.ctx.strokeStyle = hwState.STRING_BRIGHT[string] || '#fff';
            hwState.ctx.lineWidth = 2;
            hwState.ctx.beginPath();
            hwState.ctx.moveTo(x, y - dh); hwState.ctx.lineTo(x + half, y);
            hwState.ctx.lineTo(x, y + dh); hwState.ctx.lineTo(x - half, y);
            hwState.ctx.closePath(); hwState.ctx.stroke();
            // PH label for pinch harmonics
            if (isPinchHarmonic && sz >= 14) {
                hwState.ctx.fillStyle = '#ff0';
                hwState.ctx.font = `bold ${Math.max(8, sz * 0.25) | 0}px sans-serif`;
                hwState.ctx.textAlign = 'center';
                hwState.ctx.textBaseline = 'top';
                fillTextReadable(hwState, 'PH', x, y + dh + 2);
            }
        } else {
            // Glow
            hwState.ctx.fillStyle = dark;
            roundRect(hwState.ctx, x - half - 4, y - half - 4, sz + 8, sz + 8, sz / 3);
            hwState.ctx.fill();
            // Body
            hwState.ctx.fillStyle = color;
            roundRect(hwState.ctx, x - half, y - half, sz, sz, sz / 5);
            hwState.ctx.fill();
        }

        // Judgment glow (feedBack#254) — additive halo for a correct
        // hit / held sustain, faint red wash for a miss. Drawn before
        // the fret number so the number stays legible on top.
        _paintGemGlow(hwState, x, y, isHarmonic ? half * 1.2 : half, string, ns);

        // Fret number
        const fontSize = Math.max(10, sz * 0.5) | 0;
        hwState.ctx.fillStyle = '#fff';
        hwState.ctx.font = `bold ${fontSize}px sans-serif`;
        hwState.ctx.textAlign = 'center';
        hwState.ctx.textBaseline = 'middle';
        fillTextReadable(hwState, String(fret), x, y);

        // Bend notation
        if (bend && bend > 0 && sz >= 12) {
            const lw = Math.max(2, sz / 10);
            const ay = y - half - 4;
            // px above the gem for a bend of `v` semitones (shared by the
            // curve contour and the scalar-arrow fallback).
            const hOf = (v) => sz * 0.55 * Math.min(Math.max(v, 0), 2);
            const bnv = Array.isArray(opts?.bnv) ? opts.bnv : null;

            hwState.ctx.strokeStyle = '#fff';
            hwState.ctx.lineWidth = lw;

            let labelTopY;  // y of the highest drawn point, for the label
            if (bnv && bnv.length >= 2) {
                // Bend curve (§6.2.1): trace the real shape as a contour above
                // the gem (round-trip rises then falls, pre-bend starts high,
                // release descends, …) — `bt` is implicit in the point shape.
                const pts = bnvNormalizedPoints(bnv, opts?.sus);
                const gw = sz * 0.6;
                const x0 = x - gw / 2;
                hwState.ctx.beginPath();
                pts.forEach((pt, i) => {
                    const px = x0 + pt.x * gw;
                    const py = ay - hOf(pt.v);
                    if (i === 0) hwState.ctx.moveTo(px, py); else hwState.ctx.lineTo(px, py);
                });
                hwState.ctx.stroke();
                // Arrowhead only when the gesture ends rising (plain bend /
                // pre-bend); round-trip and release finish heading down.
                const a = pts[pts.length - 2], b = pts[pts.length - 1];
                if (b.v > a.v + 0.05) {
                    const tipX = x0 + b.x * gw, tipY = ay - hOf(b.v);
                    hwState.ctx.beginPath();
                    hwState.ctx.moveTo(tipX - sz * 0.1, tipY + sz * 0.12);
                    hwState.ctx.lineTo(tipX, tipY);
                    hwState.ctx.lineTo(tipX + sz * 0.1, tipY + sz * 0.12);
                    hwState.ctx.stroke();
                }
                labelTopY = ay - hOf(Math.max(...pts.map(p => p.v)));
            } else {
                // Fallback: single curved arrow up to the scalar peak.
                const arrowH = hOf(bend);  // taller for bigger bends
                const tipY = ay - arrowH;
                hwState.ctx.beginPath();
                hwState.ctx.moveTo(x, ay);
                hwState.ctx.quadraticCurveTo(x + sz * 0.2, ay - arrowH * 0.5, x, tipY);
                hwState.ctx.stroke();
                hwState.ctx.beginPath();
                hwState.ctx.moveTo(x - sz * 0.12, tipY + sz * 0.12);
                hwState.ctx.lineTo(x, tipY);
                hwState.ctx.lineTo(x + sz * 0.12, tipY + sz * 0.12);
                hwState.ctx.stroke();
                labelTopY = tipY;
            }

            // Bend label: peak magnitude — "full", "1/2", "1 1/2", "2"
            let label;
            if (bend === 0.5) label = '½';
            else if (bend === 1) label = 'full';
            else if (bend === 1.5) label = '1½';
            else if (bend === 2) label = '2';
            else label = bend.toFixed(1);

            hwState.ctx.fillStyle = '#fff';
            hwState.ctx.font = `bold ${Math.max(9, sz * 0.28) | 0}px sans-serif`;
            hwState.ctx.textAlign = 'center';
            hwState.ctx.textBaseline = 'bottom';
            fillTextReadable(hwState, label, x, labelTopY - 2);
        }

        if (sz < 14) return;  // Skip small technique labels

        // Teaching marks (§6.2.2) — display only, never grading. The fret-hand
        // finger (fg) renders by default as a small numeral hugging the gem's
        // right edge (T = thumb, 1..4), hideable via the finger-hints toggle; the
        // scale degree (sd) is opt-in and sits on the left edge so the two never
        // collide with the centred fret number.
        const fgLabel = hwState._showFingerHints ? teachingFingerLabel(opts?.fg) : '';
        if (fgLabel) {
            hwState.ctx.fillStyle = '#7fd1ff';
            hwState.ctx.font = `bold ${Math.max(8, sz * 0.26) | 0}px sans-serif`;
            hwState.ctx.textAlign = 'left';
            hwState.ctx.textBaseline = 'middle';
            fillTextReadable(hwState, fgLabel, x + half + 2, y + half * 0.5);
        }
        if (hwState._showTeachingMarks) {
            const sdLabel = teachingDegreeLabel(opts?.sd);
            if (sdLabel) {
                hwState.ctx.fillStyle = '#ffcc66';
                hwState.ctx.font = `bold ${Math.max(8, sz * 0.26) | 0}px sans-serif`;
                hwState.ctx.textAlign = 'right';
                hwState.ctx.textBaseline = 'middle';
                fillTextReadable(hwState, sdLabel, x - half - 2, y + half * 0.5);
            }
        }

        // Slide indicator (diagonal arrow). Pitched (sl) draws a solid arrow to
        // the target fret; unpitched (slu) draws a dashed diagonal with no
        // arrowhead (no definite target pitch). The two are mutually exclusive
        // in the data; the 3D highway makes the same pitched/unpitched split.
        if (slide >= 0 || slu >= 0) {
            const pitched = slide >= 0;
            const target = pitched ? slide : slu;
            const dir = target > fret ? -1 : 1;  // up or down the neck; mirror handles lefty
            hwState.ctx.strokeStyle = '#fff';
            hwState.ctx.lineWidth = Math.max(2, sz / 10);
            if (!pitched) hwState.ctx.setLineDash([Math.max(2, sz / 8), Math.max(2, sz / 8)]);
            hwState.ctx.beginPath();
            hwState.ctx.moveTo(x - sz * 0.3, y + dir * sz * 0.3);
            hwState.ctx.lineTo(x + sz * 0.3, y - dir * sz * 0.3);
            hwState.ctx.stroke();
            if (!pitched) hwState.ctx.setLineDash([]);
            // Arrowhead only for a pitched slide (definite target pitch).
            if (pitched) {
                hwState.ctx.beginPath();
                hwState.ctx.moveTo(x + sz * 0.3, y - dir * sz * 0.3);
                hwState.ctx.lineTo(x + sz * 0.15, y - dir * sz * 0.15);
                hwState.ctx.stroke();
            }
        }

        // H/P/T label above note
        if (hammerOn || pullOff || tap) {
            const label = tap ? 'T' : (hammerOn ? 'H' : 'P');
            const ly = y - half - (bend > 0 ? sz * 0.6 : 4);
            hwState.ctx.fillStyle = '#fff';
            hwState.ctx.font = `bold ${Math.max(9, sz * 0.3) | 0}px sans-serif`;
            hwState.ctx.textAlign = 'center';
            hwState.ctx.textBaseline = 'bottom';
            fillTextReadable(hwState, label, x, ly);
        }

        // Palm mute (PM below note)
        if (palmMute) {
            hwState.ctx.fillStyle = '#aaa';
            hwState.ctx.font = `bold ${Math.max(8, sz * 0.25) | 0}px sans-serif`;
            hwState.ctx.textAlign = 'center';
            hwState.ctx.textBaseline = 'top';
            fillTextReadable(hwState, 'PM', x, y + half + 2);
        }

        // Tremolo (wavy line above)
        if (tremolo) {
            const ty = y - half - (bend > 0 ? sz * 0.7 : 6);
            hwState.ctx.strokeStyle = '#ff0';
            hwState.ctx.lineWidth = 1.5;
            hwState.ctx.beginPath();
            for (let i = -3; i <= 3; i++) {
                const wx = x + i * sz * 0.08;
                const wy = ty + Math.sin(i * 2) * 3;
                if (i === -3) hwState.ctx.moveTo(wx, wy);
                else hwState.ctx.lineTo(wx, wy);
            }
            hwState.ctx.stroke();
        }

        // Accent (> marker)
        if (accent) {
            const ay2 = y - half - 4;
            hwState.ctx.strokeStyle = '#fff';
            hwState.ctx.lineWidth = 2;
            hwState.ctx.beginPath();
            hwState.ctx.moveTo(x - sz * 0.2, ay2 + 3);
            hwState.ctx.lineTo(x, ay2 - 2);
            hwState.ctx.lineTo(x + sz * 0.2, ay2 + 3);
            hwState.ctx.stroke();
        }
    }

    function drawSustains(W, H) {
        // Same master-difficulty fallback as drawNotes/drawChords —
        // without this, sustain bars for filtered-out notes would
        // still render, leaving orphan rectangles where no note head
        // is drawn.
        const src = hwState._filteredNotes !== null ? hwState._filteredNotes : hwState.notes;
        for (const n of src) {
            if (n.sus <= 0.01) continue;
            const end = n.t + n.sus;
            if (end < hwState.currentTime || n.t > hwState.currentTime + VISIBLE_SECONDS) continue;

            const t0 = Math.max(n.t - hwState.currentTime, 0);
            const t1 = Math.min(end - hwState.currentTime, VISIBLE_SECONDS);
            if (t0 >= t1) continue;

            const p0 = project(t0), p1 = project(t1);
            if (!p0 || !p1) continue;

            const x0 = fretX(hwState, n.f, p0.scale, W);
            const x1 = fretX(hwState, n.f, p1.scale, W);
            const sw0 = Math.max(2, 6 * p0.scale);
            const sw1 = Math.max(2, 6 * p1.scale);

            // feedBack#254 — a sustain that's currently being held
            // correctly "sizzles" in the bright string colour (glow +
            // flickering brightness + a crackling current down the
            // middle); otherwise the usual dim trail. A miss is left dim
            // (the gem / overlay marks the miss; a red trail would be
            // noisy). Skip the lookup entirely when no provider is set —
            // zero cost in the hot loop for the common case.
            const ns = hwState._noteStateProvider ? _noteState(hwState, n, n.t) : null;
            const litTrail = !!(ns && ns.state !== 'miss');
            const y0 = p0.y * H, y1 = p1.y * H;
            if (litTrail) {
                const a = ns.alpha;
                const col = ns.color || hwState.STRING_BRIGHT[n.s] || hwState.STRING_COLORS[n.s] || '#666';
                // Per-note seed so neighbouring sustains shimmer
                // independently. Math.floor(n.t * 60) is stable across
                // frames yet drifts on song progression; combined with
                // _frameIdx + n.s it gives a non-correlated walk through
                // the LUT, matching the original visual intent
                // (feedBack#254 comment above).
                const seedBase = (hwState._frameIdx + n.s + ((n.t * 60) | 0)) | 0;
                hwState.ctx.save();
                hwState.ctx.fillStyle = col;
                // Shimmering glow WITHOUT ctx.shadowBlur: blur cost scales with
                // the blurred DEVICE-pixel area, and a held sustain's trail can
                // span half the (DPR-scaled) canvas — profiling the "stutters
                // while playing" report put this per-frame blur pass at the top
                // exactly while a sustain is held. Three inflated low-alpha
                // fills of the same quad read as the same soft glow at a flat,
                // area-independent cost. The shimmer LUT still drives the
                // per-frame size/brightness flicker (feedBack#254 intent).
                const glowPx = (8 + 6 * _shimmerNoise(seedBase)) * a;
                const baseA = (0.45 + 0.45 * a) * (0.78 + 0.22 * _shimmerNoise(seedBase + 17));
                const fillTrail = (inflate) => {
                    hwState.ctx.beginPath();
                    hwState.ctx.moveTo(x0 - sw0 - inflate, y0);
                    hwState.ctx.lineTo(x0 + sw0 + inflate, y0);
                    hwState.ctx.lineTo(x1 + sw1 + inflate, y1);
                    hwState.ctx.lineTo(x1 - sw1 - inflate, y1);
                    hwState.ctx.fill();
                };
                hwState.ctx.globalAlpha = baseA * 0.22;
                fillTrail(glowPx);
                hwState.ctx.globalAlpha = baseA * 0.4;
                fillTrail(glowPx * 0.45);
                hwState.ctx.globalAlpha = baseA;
                fillTrail(0);
                // Crackling "current" — a jittery white core line down
                // the trail, re-randomised each frame.
                hwState.ctx.globalCompositeOperation = 'lighter';
                hwState.ctx.globalAlpha = a * (0.55 + 0.45 * _shimmerNoise(seedBase + 31));
                hwState.ctx.strokeStyle = '#ffffff';
                hwState.ctx.lineWidth = Math.max(1.5, sw0 * 0.5);
                hwState.ctx.lineJoin = 'round';
                hwState.ctx.lineCap = 'round';
                hwState.ctx.beginPath();
                const segs = 7;
                for (let k = 0; k <= segs; k++) {
                    const f = k / segs;
                    const jx = (k === 0 || k === segs) ? 0 : (_shimmerNoise(seedBase + 47 + k) - 0.5) * sw0 * 2.2;
                    const xx = x0 + (x1 - x0) * f + jx;
                    const yy = y0 + (y1 - y0) * f;
                    if (k === 0) hwState.ctx.moveTo(xx, yy); else hwState.ctx.lineTo(xx, yy);
                }
                hwState.ctx.stroke();
                hwState.ctx.restore();
            } else {
                hwState.ctx.fillStyle = hwState.STRING_DIM[n.s] || '#333';
                hwState.ctx.beginPath();
                hwState.ctx.moveTo(x0 - sw0, y0);
                hwState.ctx.lineTo(x0 + sw0, y0);
                hwState.ctx.lineTo(x1 + sw1, y1);
                hwState.ctx.lineTo(x1 - sw1, y1);
                hwState.ctx.fill();
            }
        }
    }

    function drawNotes(W, H) {
        // Master-difficulty filter (feedBack#48): when the source had
        // phrase-level ladder data, render from the mastery-filtered
        // array. _filteredNotes stays null for slider-disabled sources
        // so rendering falls through to the flat notes array unchanged.
        const src = hwState._filteredNotes !== null ? hwState._filteredNotes : hwState.notes;
        // Binary search for visible range
        const tMin = hwState.currentTime - 0.25;
        const tMax = hwState.currentTime + VISIBLE_SECONDS;
        let lo = bsearch(src, tMin);
        let hi = bsearch(src, tMax);

        // Include sustained notes
        while (lo > 0 && src[lo-1].t + src[lo-1].sus > hwState.currentTime) lo--;

        // Collect drawn positions for unison bend detection
        const drawnNotes = [];

        for (let i = hi - 1; i >= lo; i--) {
            const n = src[i];
            let tOff = n.t - hwState.currentTime;

            // Hold sustained notes at now line
            let p;
            if (tOff < -0.05 && n.sus > 0 && n.t + n.sus > hwState.currentTime) {
                p = { y: 0.82, scale: 1.0 };
            } else {
                p = project(tOff);
            }
            if (!p) continue;

            const x = fretX(hwState, n.f, p.scale, W);
            drawNote(W, H, x, p.y * H, p.scale, n.s, n.f, n, hwState._noteStateProvider ? _noteState(hwState, n, n.t) : null);
            drawnNotes.push({
                t: n.t, s: n.s, f: n.f, bn: n.bn || 0, x, y: p.y * H, scale: p.scale,
                ch: Number.isInteger(n.ch) ? n.ch : -1,
                pkd: Number.isInteger(n.pkd) ? n.pkd : -1,
            });
        }

        // Draw unison bend connectors
        drawUnisonBends(W, H, drawnNotes);
        // Strum-group brackets (teaching mark ch, §6.2.2) — opt-in overlay.
        // Scoped to standalone notes (the stream drawNotes renders); chord-note
        // strum groups aren't bracketed (the editor authors ch over single-note
        // selections, and chord notes already read as one simultaneous gesture).
        if (hwState._showTeachingMarks) drawStrumGroups(W, H, drawnNotes);
    }

    function drawStrumGroups(W, H, drawnNotes) {
        // Teaching mark (§6.2.2): notes sharing a `ch` key >= 0 are one
        // strum/rake gesture. Connect each group's gems with a bracket and a
        // single arrowhead whose direction comes from `pkd` (0 = down-strum,
        // 1 = up-strum). Display only — never grading.
        for (const group of strumGroupBuckets(drawnNotes)) {
            const pts = group.slice().sort((a, b) => a.y - b.y || a.x - b.x);
            const scale = pts[0].scale;
            const sz = Math.max(12, 80 * scale * (H / 900));
            if (sz < 14) continue;
            const pkd = (group.find(p => p.pkd === 0 || p.pkd === 1) || {}).pkd;

            hwState.ctx.save();
            hwState.ctx.strokeStyle = '#c89bff';
            hwState.ctx.lineWidth = Math.max(2, sz / 12);
            hwState.ctx.lineJoin = 'round';
            hwState.ctx.beginPath();
            pts.forEach((p, i) => (i === 0 ? hwState.ctx.moveTo(p.x, p.y) : hwState.ctx.lineTo(p.x, p.y)));
            hwState.ctx.stroke();
            // Arrowhead at the gesture start: down-strum (pkd 0) points toward
            // the last gem, up-strum (pkd 1) toward the first.
            if (pkd === 0 || pkd === 1) {
                const head = pkd === 1 ? pts[0] : pts[pts.length - 1];
                const from = pkd === 1 ? pts[1] : pts[pts.length - 2];
                const dy = Math.sign(head.y - from.y) || 1;
                const a = sz * 0.18;
                hwState.ctx.beginPath();
                hwState.ctx.moveTo(head.x - a, head.y - dy * a);
                hwState.ctx.lineTo(head.x, head.y);
                hwState.ctx.lineTo(head.x + a, head.y - dy * a);
                hwState.ctx.stroke();
            }
            hwState.ctx.restore();
        }
    }

    function drawUnisonBends(W, H, drawnNotes) {
        // Group notes by time (within 0.01s tolerance)
        const groups = [];
        const used = new Set();
        for (let i = 0; i < drawnNotes.length; i++) {
            if (used.has(i)) continue;
            const group = [drawnNotes[i]];
            used.add(i);
            for (let j = i + 1; j < drawnNotes.length; j++) {
                if (used.has(j)) continue;
                if (Math.abs(drawnNotes[j].t - drawnNotes[i].t) < 0.01) {
                    group.push(drawnNotes[j]);
                    used.add(j);
                }
            }
            if (group.length >= 2) groups.push(group);
        }

        for (const group of groups) {
            // Find pairs: one with bend, one without (or both with different bends)
            const bent = group.filter(n => n.bn > 0);
            const unbent = group.filter(n => n.bn === 0);
            if (bent.length === 0 || unbent.length === 0) continue;

            // Draw connector between each bent-unbent pair
            for (const bn of bent) {
                // Find the closest unbent note by string
                let closest = unbent[0];
                for (const ub of unbent) {
                    if (Math.abs(ub.s - bn.s) < Math.abs(closest.s - bn.s)) closest = ub;
                }

                const sz = Math.max(12, 80 * bn.scale * (H / 900));
                if (sz < 14) continue;

                // Draw a curved dashed line connecting bent note to target note
                const x1 = bn.x, y1 = bn.y;
                const x2 = closest.x, y2 = closest.y;
                const midX = (x1 + x2) / 2 + sz * 0.5;
                const midY = (y1 + y2) / 2;

                hwState.ctx.save();
                hwState.ctx.strokeStyle = '#60d0ff';
                hwState.ctx.lineWidth = Math.max(2, sz / 12);
                hwState.ctx.setLineDash([4, 4]);
                hwState.ctx.beginPath();
                hwState.ctx.moveTo(x1, y1);
                hwState.ctx.quadraticCurveTo(midX, midY, x2, y2);
                hwState.ctx.stroke();
                hwState.ctx.setLineDash([]);
                hwState.ctx.restore();

                // "U" label at midpoint
                const labelSz = Math.max(10, sz * 0.3) | 0;
                hwState.ctx.fillStyle = '#60d0ff';
                hwState.ctx.font = `bold ${labelSz}px sans-serif`;
                hwState.ctx.textAlign = 'center';
                hwState.ctx.textBaseline = 'middle';
                const cpX = (x1 + 2 * midX + x2) / 4;
                const cpY = (y1 + 2 * midY + y2) / 4;
                fillTextReadable(hwState, 'U', cpX + sz * 0.3, cpY);
            }
        }
    }

    function drawChords(W, H) {
        // See drawNotes — _filteredChords is null for slider-disabled
        // sources so we fall through to the flat chords array.
        const src = hwState._filteredChords !== null ? hwState._filteredChords : hwState.chords;
        _ensureChordRenderCache(src);

        const tMin = hwState.currentTime - 0.25;
        const tMax = hwState.currentTime + VISIBLE_SECONDS;
        const lo = bsearchChords(src, tMin);
        const hi = bsearchChords(src, tMax);

        _updateFretLinePreview(src, lo, hi);
        _drawFretLineChordPreview(W, H);

        for (let i = hi - 1; i >= lo; i--) {
            const ch = src[i];
            const p = project(ch.t - hwState.currentTime);
            if (!p) continue;

            const info = _chordRenderInfo.get(ch);
            const { isFull, baseFret, sortedNotes: sorted, nonZeroNotes, nonZeroFrets, allMuted, hasMultipleNotes } = info;

            const sz = Math.max(10, 28 * p.scale * (H / 900));
            const spread = sz * 0.85;
            const minSpread = sz + 16 * p.scale;
            const actualSpread = Math.max(spread, minSpread);
            const actualTotalH = actualSpread * Math.max(0, sorted.length - 1);

            const { tmpl, getTemplateFret } = getChordTemplateInfo(ch.id, hwState.chordTemplates);
            const hasNonZero = nonZeroNotes.length >= 1;

            const frameLeftFret = baseFret;
            const frameRightFret = baseFret + CHORD_FRAME_FRETS;

            // Frame validation — log once per chord id rather than every frame.
            if (hasNonZero && !_frameMismatchWarned.has(ch.id)) {
                let notesInFrame = true;
                for (let k = 0; k < nonZeroFrets.length; k++) {
                    const f = nonZeroFrets[k];
                    if (f < frameLeftFret || f > frameRightFret) { notesInFrame = false; break; }
                }
                if (!notesInFrame) {
                    _frameMismatchWarned.add(ch.id);
                    console.warn('Chord frame mismatch:', ch.id, { frameLeftFret, frameRightFret, nonZeroFrets });
                }
            }

            // X span between fretted notes (excluding open strings) —
            // single pass over cached nonZeroFrets, no spread + Math.min/max.
            let xMin = null, xMax = null;
            if (hasNonZero) {
                xMin = Infinity; xMax = -Infinity;
                for (let k = 0; k < nonZeroFrets.length; k++) {
                    const x = fretX(hwState, nonZeroFrets[k], p.scale, W);
                    if (x < xMin) xMin = x;
                    if (x > xMax) xMax = x;
                }
            }
            if (allMuted) {
                const { boxX, boxW, boxTop, boxH } = _computeChordBox(p, H, W, sorted, sz, actualSpread, baseFret);

                hwState.ctx.strokeStyle = MUTE_BOX_STROKE;
                hwState.ctx.lineWidth = Math.max(2, sz / 6);
                roundRect(hwState.ctx, boxX, boxTop, boxW, boxH, 2);
                hwState.ctx.stroke();

                hwState.ctx.fillStyle = MUTE_BOX_BAR;
                hwState.ctx.fillRect(boxX, boxTop + 2, boxW, 4);

                // Gray X cross, centered in frame
                const xInset = sz * 0.6;
                const xStartX = boxX + xInset;
                const xEndX = boxX + boxW - xInset;
                hwState.ctx.beginPath();
                hwState.ctx.moveTo(xStartX, boxTop + sz * 0.5);
                hwState.ctx.lineTo(xEndX, boxTop + boxH - sz * 0.5);
                hwState.ctx.moveTo(xEndX, boxTop + sz * 0.5);
                hwState.ctx.lineTo(xStartX, boxTop + boxH - sz * 0.5);
                hwState.ctx.stroke();

                continue;
            }

            // Repeat chord (mid-chain): translucent box + bracket bar.
            if (!isFull) {
                const { boxX, boxW, boxTop, boxH } = _computeChordBox(p, H, W, sorted, sz, actualSpread, baseFret);

                hwState.ctx.fillStyle = REPEAT_BOX_FILL;
                roundRect(hwState.ctx, boxX, boxTop, boxW, boxH, 2);
                hwState.ctx.fill();

                hwState.ctx.fillStyle = REPEAT_BOX_BAR;
                hwState.ctx.fillRect(boxX, boxTop + 2, boxW, 4);

                continue;
            }

            // First-in-chain (or short chain): full chord rendering.
            // Bracket bar above the notes.
            if (hasNonZero || sorted.length >= 2) {
                const positions = (hasNonZero ? nonZeroNotes : sorted).map((cn, j) => ({
                    x: fretX(hwState, cn.f, p.scale, W),
                    y: p.y * H - actualTotalH / 2 + j * actualSpread,
                }));
                const barY = positions[0].y - sz * 0.7;
                const barLeft = hasNonZero ? xMin : fretX(hwState, frameLeftFret, p.scale, W);
                const barRight = hasNonZero ? xMax : fretX(hwState, frameRightFret, p.scale, W);

                hwState.ctx.fillStyle = REPEAT_BOX_BAR;
                hwState.ctx.lineWidth = Math.max(3, sz / 4);
                roundRect(hwState.ctx, barLeft - 2, barY - 2, barRight - barLeft + 4, 4, 2);
                hwState.ctx.fill();
                for (const pos of positions) {
                    hwState.ctx.fillRect(pos.x - 2, barY, 4, pos.y - sz / 2 - barY);
                }
            }

            // Chord name label
            if (!ch.hd && p.scale > 0.15 && tmpl && tmpl.name) {
                const labelY = hasNonZero
                    ? (p.y * H - actualTotalH / 2 - sz * 0.7 - sz * 0.4)
                    : (p.y * H - sz * 0.8);
                const labelX = hasNonZero
                    ? (xMin + xMax) / 2
                    : (sorted.length >= 2
                        ? (fretX(hwState, frameLeftFret, p.scale, W) + fretX(hwState, frameRightFret, p.scale, W)) / 2
                        : fretX(hwState, sorted[0].f, p.scale, W));
                hwState.ctx.fillStyle = '#fff';
                hwState.ctx.font = `bold ${Math.max(14, sz * 0.45) | 0}px sans-serif`;
                hwState.ctx.textAlign = 'center';
                hwState.ctx.textBaseline = 'bottom';
                fillTextReadable(hwState, tmpl.name, labelX, labelY);
            }

            // Harmony annotations (§6.3.1 / §6.6) — the chord's function
            // (fn.rn Roman numeral) and template voicing, stacked above the
            // chord name. Gated behind the teaching-marks opt-in (same overlay
            // class as sd/ch) so they don't clutter the default highway.
            // Display only — never grading.
            if (hwState._showTeachingMarks && !ch.hd && p.scale > 0.15 && sorted.length > 0) {
                const { rn, voicing, caged, guideTones } = chordHarmonyLabels(
                    ch.fn, tmpl && tmpl.voicing, tmpl && tmpl.caged, tmpl && tmpl.guideTones);
                if (rn || voicing || caged || guideTones) {
                    const hx = hasNonZero
                        ? (xMin + xMax) / 2
                        : (sorted.length >= 2
                            ? (fretX(hwState, frameLeftFret, p.scale, W) + fretX(hwState, frameRightFret, p.scale, W)) / 2
                            : fretX(hwState, sorted[0].f, p.scale, W));
                    // Baseline = just above where the chord name sits.
                    const nameY = hasNonZero
                        ? (p.y * H - actualTotalH / 2 - sz * 0.7 - sz * 0.4)
                        : (p.y * H - sz * 0.8);
                    hwState.ctx.font = `bold ${Math.max(10, sz * 0.32) | 0}px sans-serif`;
                    hwState.ctx.textAlign = 'center';
                    hwState.ctx.textBaseline = 'bottom';
                    let stackY = nameY - sz * 0.5;
                    if (rn) {
                        hwState.ctx.fillStyle = '#ffcc66';   // matches the sd teaching color
                        fillTextReadable(hwState, rn, hx, stackY);
                        stackY -= sz * 0.45;
                    }
                    if (voicing) {
                        hwState.ctx.fillStyle = '#7fd1ff';   // matches the fg teaching color
                        fillTextReadable(hwState, voicing, hx, stackY);
                        stackY -= sz * 0.45;
                    }
                    if (caged) {
                        hwState.ctx.fillStyle = '#a0ffa0';   // CAGED shape teaching color
                        fillTextReadable(hwState, caged, hx, stackY);
                        stackY -= sz * 0.45;
                    }
                    if (guideTones) {
                        hwState.ctx.fillStyle = '#d0a0ff';   // guide-tone teaching color
                        fillTextReadable(hwState, guideTones, hx, stackY);
                    }
                }
            }

            // Notes — wide colored bar for open strings inside a chord,
            // normal note glyph otherwise.
            // Classify into bent / unbent arrays inline (was: post-filter
            // chordPositions twice into bent/unbent).
            const bent = [];
            const unbent = [];

            for (let j = 0; j < sorted.length; j++) {
                const cn = sorted[j];
                const x = fretX(hwState, cn.f, p.scale, W);
                const ny = p.y * H - actualTotalH / 2 + j * actualSpread;
                // feedBack#254 — per-string judgment, keyed by the
                // chord's chart time (matches how note_detect stores it).
                const cnNs = hwState._noteStateProvider ? _noteState(hwState, cn, ch.t) : null;

                // Open-string-in-chord wide bar — only when the note has no
                // technique flags. Otherwise fall back to drawNote so PM /
                // H / P / T / tremolo / accent labels still render (drawNote
                // is the only path that emits those labels).
                if (getTemplateFret(cn) === 0 && hasMultipleNotes && !_noteHasTechniqueFlags(cn)) {
                    const litBar = !!(cnNs && cnNs.state !== 'miss');
                    const color = litBar ? (cnNs.color || hwState.STRING_BRIGHT[cn.s] || hwState.STRING_COLORS[cn.s] || '#888') : (hwState.STRING_COLORS[cn.s] || '#888');
                    const dark = litBar ? (hwState.STRING_COLORS[cn.s] || '#666') : (hwState.STRING_DIM[cn.s] || '#222');
                    const barH = sz;
                    const barLeft = fretX(hwState, frameLeftFret, p.scale, W);
                    const barRight = fretX(hwState, frameRightFret, p.scale, W);
                    hwState.ctx.fillStyle = dark;
                    roundRect(hwState.ctx, barLeft - 1, ny - barH / 2 - 1, barRight - barLeft + 2, barH + 2, 3);
                    hwState.ctx.fill();
                    hwState.ctx.fillStyle = color;
                    roundRect(hwState.ctx, barLeft, ny - barH / 2, barRight - barLeft, barH, 2);
                    hwState.ctx.fill();
                    _paintGemGlow(hwState, (barLeft + barRight) / 2, ny, barH * 0.5, cn.s, cnNs);
                    const fontSize = Math.max(8, sz * 0.5) | 0;
                    hwState.ctx.fillStyle = '#fff';
                    hwState.ctx.font = `bold ${fontSize}px sans-serif`;
                    hwState.ctx.textAlign = 'center';
                    hwState.ctx.textBaseline = 'middle';
                    fillTextReadable(hwState, '0', (barLeft + barRight) / 2, ny);
                } else {
                    drawNote(W, H, x, ny, p.scale, cn.s, cn.f, { ...cn, chord: true }, cnNs);
                }

                // Nullish-coalesce (??) rather than `||`: undefined / null
                // from missing bend data still maps to 0 (matches historic
                // encoding — old code shipped `entry.bn = cn.bn || 0`), but
                // NaN stays NaN so it fails BOTH the strict-equality branch
                // below and the `> 0` branch — keeping bad data out of the
                // unbent connector set rather than silently classifying it
                // as unbent.
                const cnBn = cn.bn ?? 0;
                const entry = { s: cn.s, f: cn.f, bn: cnBn, x, y: ny, scale: p.scale };
                if (cnBn > 0) bent.push(entry);
                else if (cnBn === 0) unbent.push(entry);
            }

            // Unison bend within chord — bent / unbent classified inline above.
            if (bent.length > 0 && unbent.length > 0 && sz >= 14) {
                for (const bn of bent) {
                    let closest = unbent[0];
                    for (const ub of unbent) {
                        if (Math.abs(ub.s - bn.s) < Math.abs(closest.s - bn.s)) closest = ub;
                    }
                    const x1 = bn.x, y1 = bn.y;
                    const x2 = closest.x, y2 = closest.y;
                    const midX = (x1 + x2) / 2 + sz * 0.5;
                    const midY = (y1 + y2) / 2;

                    hwState.ctx.save();
                    hwState.ctx.strokeStyle = '#60d0ff';
                    hwState.ctx.lineWidth = Math.max(2, sz / 12);
                    hwState.ctx.setLineDash([4, 4]);
                    hwState.ctx.beginPath();
                    hwState.ctx.moveTo(x1, y1);
                    hwState.ctx.quadraticCurveTo(midX, midY, x2, y2);
                    hwState.ctx.stroke();
                    hwState.ctx.setLineDash([]);
                    hwState.ctx.restore();

                    const labelSz = Math.max(10, sz * 0.3) | 0;
                    hwState.ctx.fillStyle = '#60d0ff';
                    hwState.ctx.font = `bold ${labelSz}px sans-serif`;
                    hwState.ctx.textAlign = 'center';
                    hwState.ctx.textBaseline = 'middle';
                    const cpX = (x1 + 2 * midX + x2) / 4;
                    const cpY = (y1 + 2 * midY + y2) / 4;
                    fillTextReadable(hwState, 'U', cpX + sz * 0.3, cpY);
                }
            }
        }
    }

    function drawFretNumbers(W, H) {
        const y = H * 0.97;
        const pad = 3;
        const lo = 0;
        const hi = Math.ceil(hwState.displayMaxFret);
        const anchor = getAnchorAt(hwState.currentTime);

        hwState.ctx.font = 'bold 20px sans-serif';
        hwState.ctx.textAlign = 'center';
        hwState.ctx.textBaseline = 'middle';

        for (let fret = lo; fret <= hi; fret++) {
            if (fret < 0) continue;
            const x = fretX(hwState, fret, 1.0, W);
            const inAnchor = fret >= anchor.fret && fret <= anchor.fret + anchor.width;
            hwState.ctx.fillStyle = inAnchor ? '#e8c040' : '#8a6830';
            fillTextReadable(hwState, String(fret), x, y);
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────
    function drawLyrics(W, H) {
        if (!hwState.lyrics.length) return;

        const fontSize = Math.max(18, H * 0.028) | 0;
        const lineY = H * 0.04;

        // Vocal markers: a trailing "-" means the syllable joins the
        // next one into a single word (no space); a trailing "+" marks the end
        // of an authored line. Build a flat list of authored lines so we can
        // cap rendering to a 2-line rolling window (current + upcoming).
        if (!hwState.lyrics._lines) {
            const lines = [];
            let line = null, word = null;

            const flushWord = () => {
                if (word && word.length) line.words.push(word);
                word = null;
            };
            const flushLine = () => {
                flushWord();
                if (line && line.words.length) lines.push(line);
                line = null;
            };

            for (let i = 0; i < hwState.lyrics.length; i++) {
                const l = hwState.lyrics[i];
                const raw = l.w || '';
                const endsLine = raw.endsWith('+');
                const continuesWord = raw.endsWith('-');

                // Safety fallback: if a song has no "+" markers at all, force a
                // line break on any gap > 4s so we never build a single giant line.
                if (line && i > 0) {
                    const prev = hwState.lyrics[i - 1];
                    if (l.t - (prev.t + prev.d) > 4.0) flushLine();
                }

                if (!line) line = { words: [], start: l.t, end: l.t + l.d };
                if (!word) word = [];

                word.push(l);
                line.end = Math.max(line.end, l.t + l.d);

                if (!continuesWord) flushWord();
                if (endsLine) flushLine();
            }
            flushLine();

            hwState.lyrics._lines = lines;
        }

        const allLines = hwState.lyrics._lines;
        if (!allLines.length) return;

        // Current line = most recently started line. Before the first line has
        // started, preview the first line if it's within 2s of starting.
        let currentIdx = -1;
        for (let i = 0; i < allLines.length; i++) {
            if (allLines[i].start <= hwState.currentTime) currentIdx = i;
            else break;
        }
        if (currentIdx === -1) {
            if (allLines[0].start - hwState.currentTime > 2.0) return;
            currentIdx = 0;
        }

        const currentLine = allLines[currentIdx];
        const nextLine = allLines[currentIdx + 1] || null;
        const gapToNext = nextLine ? (nextLine.start - currentLine.end) : Infinity;

        // Hide once the current line is clearly over and nothing relevant follows.
        if (hwState.currentTime > currentLine.end + 0.5 && gapToNext > 3.0) return;

        const linesToShow = [currentLine];
        if (nextLine && gapToNext <= 3.0) linesToShow.push(nextLine);

        const sylText = (s) => {
            const t = s.w || '';
            return (t.endsWith('+') || t.endsWith('-')) ? t.slice(0, -1) : t;
        };

        hwState.ctx.font = `bold ${fontSize}px sans-serif`;
        const spaceWidth = _measureLyricText(hwState.ctx, fontSize, ' ');
        const maxWidth = W * 0.8;

        // Respect authored line breaks; wrap only if a line overflows maxWidth.
        const rows = [];
        for (const authoredLine of linesToShow) {
            let row = [], rowWidth = 0;
            for (const wordSyls of authoredLine.words) {
                const parts = [];
                let wordWidth = 0;
                for (const s of wordSyls) {
                    const text = sylText(s);
                    const w = _measureLyricText(hwState.ctx, fontSize, text);
                    parts.push({ syl: s, text, width: w });
                    wordWidth += w;
                }
                const advance = wordWidth + spaceWidth;
                if (row.length > 0 && rowWidth + advance > maxWidth) {
                    rows.push(row);
                    row = []; rowWidth = 0;
                }
                row.push({ parts, advance });
                rowWidth += advance;
            }
            if (row.length) rows.push(row);
        }

        const rowHeight = fontSize + 6;
        const totalHeight = rows.length * rowHeight + 10;
        let bgWidth = 0;
        for (const row of rows) {
            const rw = row.reduce((s, w) => s + w.advance, 0) - spaceWidth;
            if (rw > bgWidth) bgWidth = rw;
        }
        bgWidth = Math.min(bgWidth + 30, W * 0.85);

        hwState.ctx.fillStyle = 'rgba(0,0,0,0.7)';
        roundRect(hwState.ctx, W/2 - bgWidth/2, lineY - 4, bgWidth, totalHeight, 8);
        hwState.ctx.fill();

        hwState.ctx.textAlign = 'left';
        hwState.ctx.textBaseline = 'top';

        for (let r = 0; r < rows.length; r++) {
            const row = rows[r];
            const rowWidth = row.reduce((s, w) => s + w.advance, 0) - spaceWidth;
            let xPos = W/2 - rowWidth/2;
            const yPos = lineY + r * rowHeight + 2;

            for (const w of row) {
                for (const part of w.parts) {
                    const l = part.syl;
                    const isActive = hwState.currentTime >= l.t && hwState.currentTime < l.t + l.d;
                    const isPast = hwState.currentTime >= l.t + l.d;

                    if (isActive) {
                        hwState.ctx.fillStyle = '#4ae0ff';
                        hwState.ctx.font = `bold ${fontSize}px sans-serif`;
                    } else if (isPast) {
                        hwState.ctx.fillStyle = '#8899aa';
                        hwState.ctx.font = `normal ${fontSize}px sans-serif`;
                    } else {
                        hwState.ctx.fillStyle = '#556677';
                        hwState.ctx.font = `normal ${fontSize}px sans-serif`;
                    }

                    hwState.ctx.fillText(part.text, xPos, yPos);
                    xPos += part.width;
                }
                xPos += spaceWidth;
            }
        }
    }

    function bsearch(arr, time) {
        let lo = 0, hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid].t < time) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }
    function bsearchChords(arr, time) {
        let lo = 0, hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid].t < time) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }
    // Lower-bound binary search for `.time`-keyed arrays (beats, anchors,
    // sections) — bsearch/bsearchChords key on `.t` and would compare
    // against undefined here. Exposed to custom viz as
    // bundle.lowerBoundTime.
    function bsearchTime(arr, time) {
        let lo = 0, hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid].time < time) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    // Reset all chord-render-derived state. Called from init() and
    // reconnect() so per-song state (preview, frame-mismatch warnings,
    // chain cache) doesn't leak across songs that reuse chord IDs.
    function _resetChordRenderState() {
        hwState._lastChordOnFretLine = null;
        hwState._chordFretLineNotes = [];
        _frameMismatchWarned.clear();
        hwState._chordRenderCacheSrc = null;
        hwState._chordRenderCacheInverted = null;
        hwState._chordRenderCacheTemplates = null;
    }

    // True if a chord note carries per-strum technique data (bend,
    // hammer/pull/tap, slide, palm-mute, vibrato, tremolo, accent, harmonic, pinch
    // harmonic, dead note). drawNote shows these in 3D (`ac` accent is a brighter
    // gem instead of a glyph there). Alternate render paths (repeat box,
    // open-string-in-chord wide bar)
    // bypass drawNote and so must fall back to the full path whenever a
    // technique flag is present, otherwise authored cues vanish silently.
    function _noteHasTechniqueFlags(n) {
        if (n.bn || n.ho || n.po || n.tp || n.pm || n.vb || n.tr || n.ac || n.hm || n.hp || n.mt || n.fhm) return true;
        if (typeof n.sl === 'number' && n.sl >= 0) return true;
        return false;
    }
    function _chordHasTechniqueFlags(ch) {
        const notes = ch.notes;
        for (let i = 0; i < notes.length; i++) {
            if (_noteHasTechniqueFlags(notes[i])) return true;
        }
        return false;
    }

    // Template lookup: returns helpers that classify a chord note's fret
    // against its template. Open = template fret 0 (regardless of cn.f).
    function getChordTemplateInfo(chordId, chordTemplates) {
        const tmpl = chordTemplates[chordId];
        const tmplFrets = tmpl && tmpl.frets ? tmpl.frets : [];
        const getTemplateFret = (cn) => cn.s < tmplFrets.length ? tmplFrets[cn.s] : cn.f;
        const isOpen = (cn) => getTemplateFret(cn) === 0;
        return { tmpl, tmplFrets, getTemplateFret, isOpen };
    }

    // Build _chordRenderInfo for every chord in `src` if the cache is stale.
    // Two passes over the array: chain bounds, then base-fret resolution
    // (which can read previous chord's cached baseFret).
    function _ensureChordRenderCache(src) {
        const templatesChanged = hwState._chordRenderCacheTemplates !== hwState.chordTemplates;
        if (hwState._chordRenderCacheSrc === src && hwState._chordRenderCacheInverted === hwState._inverted && !templatesChanged) return;
        hwState._chordRenderCacheSrc = src;
        hwState._chordRenderCacheInverted = hwState._inverted;
        hwState._chordRenderCacheTemplates = hwState.chordTemplates;
        // Templates feed isOpen() — when they land after `chords`,
        // _updateFretLinePreview's stashed open/non-open classification
        // for the currently-active chord is also stale. It only refreshes
        // on the next chord transition, so force a refresh here.
        if (templatesChanged) {
            hwState._lastChordOnFretLine = null;
            hwState._chordFretLineNotes = [];
            // Also clear the once-per-chord-id frame-mismatch warner —
            // a chord ID warned against stale (missing/empty) templates
            // would otherwise never be re-validated against the
            // corrected templates that just landed.
            _frameMismatchWarned.clear();
        }

        // Pass 1: walk forward, marking chain index / length / isFull on a
        // per-chord WeakMap entry. A chain breaks when the next chord has a
        // different id OR the time gap is >= CHAIN_GAP_THRESHOLD.
        // Chords that carry per-strum technique flags (bend / palm-mute /
        // hammer / pull / tap / slide / vibrato / tremolo / accent / harmonic / mute)
        // never collapse to a repeat box — those cues are authored on each
        // strum and must stay visible.
        let chainStart = 0;
        for (let i = 0; i <= src.length; i++) {
            const breakHere = (i === src.length) ||
                (i > chainStart && (src[i].id !== src[i - 1].id ||
                    Math.abs(src[i].t - src[i - 1].t) >= CHAIN_GAP_THRESHOLD));
            if (breakHere && i > chainStart) {
                const len = i - chainStart;
                for (let k = chainStart; k < i; k++) {
                    const chainIndex = k - chainStart;
                    const hasTechniques = _chordHasTechniqueFlags(src[k]);
                    _chordRenderInfo.set(src[k], {
                        chainIndex,
                        chainLen: len,
                        isFull: len < CHAIN_RENDER_FULL_MAX || chainIndex === 0 || hasTechniques,
                        baseFret: 0,        // filled in pass 2
                        sortedNotes: null,   // ↓ all filled in pass 2 — cached to skip
                        nonZeroNotes: null,  //   per-frame sort/filter/min/max in drawChords.
                        nonZeroFrets: null,
                        allMuted: false,
                        hasMultipleNotes: false,
                    });
                }
                chainStart = i;
            }
        }

        // Pass 2: resolve baseFret. Fretted chords use their own lowest
        // non-open fret; chained same-id chords inherit from the previous
        // entry; open-only / muted chords with a different-id predecessor
        // inherit that predecessor's frame too. The walk is forward so
        // prev's cached value is always present when we read it.
        for (let i = 0; i < src.length; i++) {
            const ch = src[i];
            const info = _chordRenderInfo.get(ch);
            const { isOpen } = getChordTemplateInfo(ch.id, hwState.chordTemplates);
            const sortedNotes = [...ch.notes].sort((a, b) => hwState._inverted ? b.s - a.s : a.s - b.s);
            const nonZero = sortedNotes.filter(cn => !isOpen(cn));
            const nonZeroFrets = nonZero.map(cn => cn.f);
            if (nonZero.length >= 1) {
                let minF = nonZeroFrets[0];
                for (let j = 1; j < nonZeroFrets.length; j++) if (nonZeroFrets[j] < minF) minF = nonZeroFrets[j];
                info.baseFret = minF;
            } else if (i > 0) {
                const prevInfo = _chordRenderInfo.get(src[i - 1]);
                info.baseFret = prevInfo ? prevInfo.baseFret : 0;
            } else {
                info.baseFret = 0;
            }
            info.sortedNotes = sortedNotes;
            info.nonZeroNotes = nonZero;
            info.nonZeroFrets = nonZeroFrets;
            info.hasMultipleNotes = sortedNotes.length >= 2;
            let allMuted = sortedNotes.length > 0;
            if (allMuted) {
                for (let j = 0; j < sortedNotes.length; j++) {
                    if (!(sortedNotes[j].mt || sortedNotes[j].fhm)) { allMuted = false; break; }
                }
            }
            info.allMuted = allMuted;
        }
    }

    // Compute the on-screen box for a chord (used by both muted and repeat
    // box renderings). Box height tracks the per-string note positions; box
    // width spans the CHORD_FRAME_FRETS frame anchored at info.baseFret.
    function _computeChordBox(p, H, W, sorted, sz, actualSpread, baseFret) {
        const actualTotalH = actualSpread * Math.max(0, sorted.length - 1);
        const yCenter = p.y * H;
        const boxTop = yCenter - actualTotalH / 2 - sz * 0.5;
        const boxBottom = boxTop + Math.max(sz, actualTotalH + sz);
        const boxX = fretX(hwState, baseFret, p.scale, W);
        const boxW = fretX(hwState, baseFret + CHORD_FRAME_FRETS, p.scale, W) - boxX;
        return { boxX, boxW, boxTop, boxH: boxBottom - boxTop };
    }

    // Search [lo, hi) for the chord we should preview on the static fret
    // line. Prefer the chord nearest the strum line that's within
    // [target - before, target + after]; if none match, fall back to the
    // first visible chord. Updates _lastChordOnFretLine / _chordFretLineNotes
    // only when the active chord changes (lets the preview persist while a
    // chord is held).
    function _updateFretLinePreview(src, lo, hi) {
        const targetTime = hwState.currentTime + FRETLINE_TARGET_OFFSET;
        let activeChord = null;
        let activeNotesOnFret = [];
        let bestChordTime = -Infinity;

        for (let i = lo; i < hi; i++) {
            const ch = src[i];
            if (ch.t >= targetTime - FRETLINE_WINDOW_BEFORE &&
                ch.t < targetTime + FRETLINE_WINDOW_AFTER &&
                ch.t > bestChordTime) {
                bestChordTime = ch.t;
                activeChord = ch;
                const { isOpen } = getChordTemplateInfo(ch.id, hwState.chordTemplates);
                const nonZero = ch.notes.filter(cn => !isOpen(cn));
                activeNotesOnFret = nonZero.length >= 1 ? nonZero.map(cn => ({ s: cn.s, f: cn.f })) : [];
            }
        }

        if (activeChord === null) {
            for (let i = lo; i < hi; i++) {
                const ch = src[i];
                const p = project(ch.t - hwState.currentTime);
                if (!p) continue;
                activeChord = ch;
                const { isOpen } = getChordTemplateInfo(ch.id, hwState.chordTemplates);
                const nonZero = ch.notes.filter(cn => !isOpen(cn));
                activeNotesOnFret = nonZero.length >= 1 ? nonZero.map(cn => ({ s: cn.s, f: cn.f })) : [];
                break;
            }
        }

        // Compare by chord OBJECT identity rather than .id — two strums of
        // the same chord template are different objects, so a chain like
        // (G normal) → (G all-muted) refreshes the preview instead of
        // leaving the first strum's fingerings stuck on the fret line.
        if (activeChord !== hwState._lastChordOnFretLine) {
            hwState._chordFretLineNotes = activeNotesOnFret;
            hwState._lastChordOnFretLine = activeChord;
        }
    }

    function _drawFretLineChordPreview(W, H) {
        if (hwState._chordFretLineNotes.length === 0) return;
        const strTop = H * 0.83;
        const strBot = H * 0.95;
        // Scale glyphs with H so preview stays proportionate at any
        // resolution / renderScale. Constants picked to match the prior
        // hardcoded 30px diameter / 24px font at H=900.
        const noteSize = Math.max(14, H * 0.033);
        const fontSize = Math.max(11, H * 0.027) | 0;
        hwState.ctx.font = `bold ${fontSize}px sans-serif`;
        hwState.ctx.textAlign = 'center';
        hwState.ctx.textBaseline = 'middle';
        for (const cn of hwState._chordFretLineNotes) {
            const yi = hwState._inverted ? 5 - cn.s : cn.s;
            const syl = strTop + (yi / 5) * (strBot - strTop);
            const fretXPos = fretX(hwState, cn.f, 1, W);
            hwState.ctx.fillStyle = hwState.STRING_COLORS[cn.s] || '#888';
            hwState.ctx.beginPath();
            hwState.ctx.arc(fretXPos, syl, noteSize / 2, 0, Math.PI * 2);
            hwState.ctx.fill();
            hwState.ctx.fillStyle = '#fff';
            fillTextReadable(hwState, String(cn.f), fretXPos, syl);
        }
    }

    // Rebuild the mastery-filtered note/chord arrays from _phrases +
    // _mastery. Called on `ready` and on every setMastery(). When
    // _phrases is null (slider-disabled source), we clear the filtered
    // arrays — drawNotes/drawChords fall through to the flat arrays.
    //
    // Output arrays are pre-sorted by time because phrase iterations
    // arrive in chronological order and within each level the notes/
    // chords are time-sorted already (PR 1's parser sorts them), so
    // concatenation preserves the order. No explicit sort needed.
    function _rebuildMasteryFilter() {
        // Null OR empty → fall through to flat arrays. The server's
        // chunked emission invariant means _phrases should never land
        // at `[]` in practice (it'd require the `phrases` message to
        // fire with zero data), but the defensive guard means a bug
        // on the way in wouldn't blank the chart.
        if (hwState._phrases === null || hwState._phrases.length === 0) {
            hwState._filteredNotes = null;
            hwState._filteredChords = null;
            hwState._filteredAnchors = null;
            hwState._filteredHandShapes = null;
            hwState._phrasesHaveHandShapes = false;
            return;
        }
        const outNotes = [];
        const outChords = [];
        const outAnchors = [];
        const outHandShapes = [];
        // Scan EVERY level (not just the current mastery's slice): if
        // any level anywhere authored a handshape, the chart's phrase
        // data is the authoritative source and the bundle should
        // respect filtered emptiness strictly. Otherwise, the chart
        // didn't ship handshapes via phrases at all and we should fall
        // back to the flat arrangement-root list (DLC pattern).
        let anyHandShapeInPhrases = false;
        for (const p of hwState._phrases) {
            const n = p.levels.length;
            if (n === 0) continue;
            // Map slider fraction to a level index. `n` already equals
            // `max_difficulty + 1` for fully-authored phrases, and
            // equals the authored-level count otherwise — so indexing
            // into p.levels.length is both correct and defensive.
            const idx = Math.min(n - 1, Math.floor(hwState._mastery * n));
            const lv = p.levels[idx];
            for (const x of lv.notes)   outNotes.push(x);
            for (const x of lv.chords)  outChords.push(x);
            // Anchors drive the fret zoom / pan. Keeping max-mastery
            // anchors while hiding higher-difficulty notes would leave
            // the highway panning into empty regions — filter them to
            // the same level as the notes they pair with.
            for (const x of lv.anchors) outAnchors.push(x);
            for (const x of (lv.handshapes || [])) outHandShapes.push(x);
            if (!anyHandShapeInPhrases) {
                for (const level of p.levels) {
                    if (level.handshapes && level.handshapes.length > 0) {
                        anyHandShapeInPhrases = true;
                        break;
                    }
                }
            }
        }
        hwState._filteredNotes = outNotes;
        hwState._filteredChords = outChords;
        hwState._filteredAnchors = outAnchors;
        if (outHandShapes.length) {
            outHandShapes.sort((a, b) => a.start_time - b.start_time);
        }
        hwState._filteredHandShapes = outHandShapes;
        hwState._phrasesHaveHandShapes = anyHandShapeInPhrases;
    }

    // ── Public API ───────────────────────────────────────────────────────
    const api = {
        init(canvasEl, container) {
            hwState.canvas = canvasEl;
            hwState._resizeContainer = container || null;
            hwState._domVisSampledFrame = NaN; // new mount → fresh DOM sample
            // Size the canvas BEFORE installing the renderer so
            // _setRenderer's init/resize calls see the real dimensions
            // instead of the default 300x150 backing store. Otherwise
            // WebGL renderers would allocate framebuffers at the wrong
            // size and immediately have to tear them down when
            // api.resize fires afterwards.
            this.resize();
            // Install the default renderer on first init. If a caller
            // pre-selected a custom renderer before init ran (e.g.
            // app.js restoring a saved viz picker selection at page
            // load), re-apply that choice now that the canvas is
            // available instead of clobbering it with the default.
            // _setRenderer(_renderer) is correct: it re-applies the
            // selected renderer now that the canvas exists, and only
            // destroys the previous renderer if it had been
            // successfully init'd before this mount (so a pre-selected
            // renderer that never saw a canvas gets init'd fresh, not
            // destroy+init'd).
            _setRenderer(hwState._renderer || _defaultRenderer);
            if (hwState._resizeHandler) window.removeEventListener('resize', hwState._resizeHandler);
            hwState._resizeHandler = () => this.resize();
            window.addEventListener('resize', hwState._resizeHandler);
            hwState.ready = false;
            hwState.notes = []; hwState.chords = []; hwState.handShapes = []; hwState.beats = []; hwState.sections = []; hwState.anchors = []; hwState.chordTemplates = []; hwState.lyrics = []; hwState.lyricsSource = ""; hwState.toneChanges = []; hwState.toneBase = ""; hwState.drumTab = null;
            hwState.stringCount = 6;  // default until song_info arrives
            // Reset phrase ladder + filter (feedBack#48). _mastery
            // persists across arrangement switches — the slider's
            // position stays put. Filter rebuilds on the next `ready`
            // once the new arrangement's phrases arrive (or stays
            // disabled if the new source has no phrase data).
            hwState._phrases = null;
            hwState._filteredNotes = null;
            hwState._filteredChords = null;
            hwState._filteredAnchors = null;
            hwState._filteredHandShapes = null;
            hwState._phrasesHaveHandShapes = false;
            _resetChordRenderState();
        },

        resize() {
            if (!hwState.canvas) return;
            // Layout just changed (window resize / container swap) —
            // re-sample DOM visibility on the next check.
            hwState._domVisSampledFrame = NaN;
            let w, h;
            if (hwState._resizeContainer) {
                const rect = hwState._resizeContainer.getBoundingClientRect();
                w = rect.width;
                h = rect.height;
            } else {
                // Measure #player-footer (Section Practice bar + transport row)
                // so the canvas doesn't draw under the practice bar; fall back
                // to #player-controls if the footer wrapper isn't present.
                const controls = document.getElementById('player-footer')
                    || document.getElementById('player-controls');
                const controlsH = controls ? controls.offsetHeight : 50;
                w = document.documentElement.clientWidth;
                h = document.documentElement.clientHeight - controlsH;
            }
            hwState.canvas.style.width = w + 'px';
            hwState.canvas.style.height = h + 'px';
            hwState.canvas.width = Math.round(w * _effectiveRenderScale());
            hwState.canvas.height = Math.round(h * _effectiveRenderScale());
            // Notify the active renderer so WebGL / offscreen buffers
            // can recreate their framebuffers. Setting canvas.width
            // above already invalidates both 2D and WebGL state — any
            // renderer relying on persistent GPU resources listens here.
            //
            // Gated on _rendererInited: a renderer pre-selected via
            // setRenderer before api.init has run is stashed but not
            // initialized yet. Calling resize() on it would violate
            // the init-before-resize contract and can break renderers
            // that assume resize() means "canvas dims changed after
            // setup." The subsequent api.init will call its resize()
            // once init succeeds.
            if (hwState._renderer && hwState._rendererInited && typeof hwState._renderer.resize === 'function') {
                try { hwState._renderer.resize(hwState.canvas.width, hwState.canvas.height); }
                catch (e) { console.error('renderer resize:', e); }
            }
        },

        setRenderScale(scale) {
            const v = Number(scale);
            // Reject non-finite input (undefined / NaN / non-numeric) so a
            // bad caller can't poison _renderScale and blank the canvas;
            // keep the current scale in that case. Mirrors the load guard.
            if (!Number.isFinite(v)) return;
            hwState._renderScale = Math.max(0.25, Math.min(1, v));
            localStorage.setItem('renderScale', hwState._renderScale);
            this.resize();
        },

        getRenderScale() { return hwState._renderScale; },

        /**
         * The render loop's own cost, for benchmarks and the perf HUD.
         *
         * WHY THIS EXISTS. The highway AUTO-SCALES: when the smoothed draw cost climbs past
         * _DRAW_BUDGET_HI_MS it lowers the render resolution to protect the frame rate
         * (#654). That is exactly right for players — and it means a performance regression
         * does NOT show up as dropped frames. It shows up as a BLURRIER PICTURE at a
         * perfectly healthy 60fps. Benchmark the frame rate and you will measure the
         * feedback loop, not the renderer, and conclude nothing changed.
         *
         * So a real perf gate has to pin the scale (setMinRenderScale(1)) and watch
         * `drawMs`. Everything needed for that is here; none of it was reachable before.
         *
         * `effectiveScale` is what actually got rendered: renderScale x autoScale.
         */
        getPerf() {
            return {
                drawMs: hwState._drawMsEMA,          // smoothed cost of _renderer.draw()
                frameMs: hwState._frameMsEMA,        // smoothed frame interval
                renderScale: hwState._renderScale,   // the user's Quality setting
                autoScale: hwState._autoScale,       // what the load-adaptive loop chose
                effectiveScale: _effectiveRenderScale(),
                drawBudgetHiMs: _DRAW_BUDGET_HI_MS,
                drawBudgetLoMs: _DRAW_BUDGET_LO_MS,
            };
        },

        // Floor for the load-adaptive render scale (#654). 0.25 = stock (allows
        // quarter-res on heavy frames), 1.0 = never auto-downscale below the
        // Quality (renderScale) ceiling — so it's only full resolution when
        // Quality is HD; otherwise it pins at the chosen Quality. Persisted;
        // takes effect immediately via resize(). Exposed as the "Min res"
        // control next to Quality in the player controls.
        setMinRenderScale(scale) {
            const v = Number(scale);
            if (!Number.isFinite(v)) return;
            hwState._autoScaleMin = Math.max(_AUTO_SCALE_MIN, Math.min(1, v));
            // Pull the live multiplier back within the new bounds so a raised
            // floor applies at once and a previously-low (or, defensively, a
            // >1) _autoScale can't strand the resolution when the floor changes.
            const lo = hwState._renderScale > 0 ? Math.min(1, hwState._autoScaleMin / hwState._renderScale) : 1;
            hwState._autoScale = Math.max(lo, Math.min(1, hwState._autoScale));
            localStorage.setItem('highwayMinRenderScale', hwState._autoScaleMin);
            this.resize(); // recompute the backing store via _effectiveRenderScale()
        },
        getMinRenderScale() { return hwState._autoScaleMin; },

        // Scale actually applied = manual ceiling * load-adaptive factor (#654).
        getEffectiveRenderScale() { return _effectiveRenderScale(); },
        // Live perf numbers a reporter or the HUD can read to confirm the
        // adaptive cap is holding.
        getPerfStats() {
            return {
                drawMs: hwState._drawMsEMA,
                autoScale: hwState._autoScale,
                renderScale: hwState._renderScale,
                effectiveScale: _effectiveRenderScale(),
            };
        },

        getInverted() { return hwState._inverted; },
        setInverted(v) { hwState._inverted = v; localStorage.setItem('invertHighway', v); },
        setLefty(on) {
            hwState._lefty = !!on;
            localStorage.setItem('lefty', hwState._lefty ? '1' : '0');
        },

        getLefty() { return hwState._lefty; },

        // Master-difficulty (feedBack#48). Per-instance: splitscreen
        // plugins that call createHighway() separately get their own
        // _mastery via closure.
        setMastery(fraction) {
            // Same NaN guard as the init (plugins could pass undefined
            // or a string that coerces badly). Silently ignore — the
            // caller probably meant to pass a number; keeping the
            // previous value is safer than propagating NaN into
            // Math.floor → p.levels[NaN].
            const next = Number(fraction);
            if (!Number.isFinite(next)) return;
            hwState._mastery = Math.max(0, Math.min(1, next));
            _rebuildMasteryFilter();
        },
        getMastery() { return hwState._mastery; },
        // Align with _rebuildMasteryFilter's own "null OR empty → fall
        // through" check. If we returned true for _phrases = [], the
        // slider would be enabled (via song:ready's hasPhraseData) but
        // dragging it would do nothing (filter stays null). Same
        // sentinel, same check, single source of truth.
        hasPhraseData() { return !!(hwState._phrases && hwState._phrases.length > 0); },
        // Lightweight phrase windows for Section Practice — timing only, no note payloads.
        getPracticePhrases() {
            if (!hwState._phrases || !hwState._phrases.length) return null;
            return hwState._phrases.map((p, index) => ({
                index,
                start_time: p.start_time,
                end_time: p.end_time,
                max_difficulty: p.max_difficulty,
            }));
        },

        connect(wsUrl, opts = {}) {
            hwState._connectOpts = opts;
            // Bump generation so async handlers from the previous connection
            // can detect they are stale and skip state mutations.
            hwState._wsGen += 1;
            // Fresh routing promise for this connection's song_info load.
            hwState._juceRoutingPromise = Promise.resolve();
            // Clear any stale "initial routing in-flight" flag from a prior
            // connection so the app.js engine-reroute watcher isn't wedged.
            window._highwayJuceRoutingPending = false;
            hwState.ws = new WebSocket(wsUrl);
            hwState.ws.onclose = () => { console.log('WS closed'); };
            hwState.ws.onerror = (e) => { console.error('WS error', e); };
            // Reset the serialization chain so old in-flight handlers
            // from a previous connection don't delay new messages.
            hwState._msgChain = Promise.resolve();

            // Helper: attach the HTML5 audio buffering overlay to `audio`.
            // Shared by both the direct HTML5 path and the JUCE fallback path.
            function _showAudioBufferingOverlay(audio) {
                let overlay = document.getElementById('audio-buffer-overlay');
                if (!overlay) {
                    overlay = document.createElement('div');
                    overlay.id = 'audio-buffer-overlay';
                    overlay.className = 'fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm';
                    overlay.innerHTML = `
                        <div class="bg-dark-700 border border-gray-700 rounded-2xl p-6 w-72 text-center shadow-2xl">
                            <div class="text-sm text-gray-300 mb-3">Loading audio...</div>
                            <div style="height:6px;background:#1a1a2e;border-radius:999px;overflow:hidden">
                                <div id="audio-buffer-bar" style="height:100%;background:linear-gradient(90deg,#4080e0,#60a0ff);border-radius:999px;width:0%;transition:width 0.3s"></div>
                            </div>
                            <div class="text-xs text-gray-500 mt-2" id="audio-buffer-pct">0%</div>
                        </div>`;
                    document.body.appendChild(overlay);
                }

                const bar = document.getElementById('audio-buffer-bar');
                const pct = document.getElementById('audio-buffer-pct');
                const MIN_BUFFER_SECS = 30;

                function onProgress() {
                    if (audio.buffered.length > 0 && audio.duration > 0) {
                        const loaded = audio.buffered.end(audio.buffered.length - 1);
                        const p = Math.round((loaded / audio.duration) * 100);
                        if (bar) bar.style.width = p + '%';
                        if (pct) pct.textContent = p + '%';
                        if (loaded >= MIN_BUFFER_SECS || loaded >= audio.duration) {
                            cleanup();
                        }
                    }
                }

                function cleanup() {
                    audio.removeEventListener('progress', onProgress);
                    audio.removeEventListener('canplaythrough', cleanup);
                    const ol = document.getElementById('audio-buffer-overlay');
                    if (ol) ol.remove();
                }

                audio.addEventListener('progress', onProgress);
                audio.addEventListener('canplaythrough', cleanup, { once: true });
            }

            hwState.ws.onmessage = (ev) => {
                const data = ev.data;
                // Capture generation synchronously before any async work so
                // stale completions from a prior WebSocket can be detected.
                const gen = hwState._wsGen;
                hwState._msgChain = hwState._msgChain.then(async () => {
                    // Bail out if a reconnect happened while this step was queued.
                    if (gen !== hwState._wsGen) return;
                    try {
                    const msg = JSON.parse(data);
                    if (msg.error) {
                        console.error('Server error:', msg.error);
                        if (opts.onError) opts.onError(msg.error);
                        else alert('Error: ' + msg.error);
                        return;
                    }
                    switch (msg.type) {
                        case 'loading':
                            console.log('Loading:', msg.stage);
                            break;
                        case 'song_info':
                            // Normalise to camelCase so matchesArrangement predicates
                            // can use songInfo.hasNotation without knowing the wire
                            // field name. Keep has_notation intact for consumers that
                            // already read the raw field (e.g. _isNotationOnlySong).
                            hwState.songInfo = Object.assign({}, msg, {
                                hasNotation: Boolean(msg.has_notation),
                                hasDrumTab: Boolean(msg.has_drum_tab),
                            });
                            _reportAudioSessionStart(msg);
                            {
                                const parsedOffset = Number(msg.offset);
                                hwState.songOffset = Number.isFinite(parsedOffset) ? parsedOffset : 0.0;
                            }
                            // Pick up the active arrangement's string count.
                            // Prefer the explicit `stringCount` field (added
                            // in feedBack-plugin-3dhighway#7); fall back to
                            // `tuning.length` for older servers that haven't
                            // started emitting it (works correctly for
                            // GP-imported sources where tuning is already
                            // truncated, and for sloppaks loaded against an
                            // updated lib/song.py); final fallback is 6 for
                            // safety so a missing/malformed payload doesn't
                            // surface as 0 strings.
                            //
                            // Clamp to [1, MAX_STRINGS] before storing —
                            // stringCount drives loop bounds in drawStrings
                            // and downstream plugins. A malformed payload
                            // (huge or zero / negative) would otherwise hang
                            // the UI or render no strings at all. 8 covers
                            // every real-world instrument we ship colors
                            // for; values above that fall back to '#888'
                            // anyway via the STRING_COLORS lookup so
                            // capping the loop bound costs nothing visible.
                            const MAX_STRINGS = 8;
                            let _sc;
                            if (typeof msg.stringCount === 'number' && msg.stringCount > 0) {
                                _sc = msg.stringCount;
                            } else if (Array.isArray(msg.tuning) && msg.tuning.length > 0) {
                                _sc = msg.tuning.length;
                            } else {
                                _sc = 6;
                            }
                            // Math.trunc(_sc) (with finite check) instead of
                            // `_sc | 0` — bitwise-OR forces 32-bit signed
                            // conversion, so any value ≥ 2^31 wraps negative
                            // and the Math.max(1, ...) clamp would land at
                            // 1 string. Math.trunc preserves the magnitude;
                            // the Math.min(MAX_STRINGS, ...) below caps it
                            // safely.
                            const _scTrunc = Number.isFinite(_sc) ? Math.trunc(_sc) : 1;
                            hwState.stringCount = Math.max(1, Math.min(MAX_STRINGS, _scTrunc));
                            if (opts.onSongInfo) {
                                opts.onSongInfo(msg);
                            } else {
                                document.getElementById('hud-artist').textContent = msg.artist;
                                document.getElementById('hud-title').textContent = msg.title;
                                // Prefer the server-echoed naming_mode (resolved from
                                // the WS query param) so the HUD stays consistent with
                                // app.js's in-memory cache even when localStorage is
                                // unavailable. Fall back to localStorage for older
                                // backends that don't echo it yet.
                                let namingMode = msg.naming_mode;
                                if (namingMode !== 'smart' && namingMode !== 'legacy') {
                                    try { namingMode = localStorage.getItem('arrangementNamingMode') === 'legacy' ? 'legacy' : 'smart'; } catch (_) { namingMode = 'smart'; }
                                }
                                const arrLabel = (namingMode === 'smart' && msg.arrangement_smart_name)
                                    ? msg.arrangement_smart_name
                                    : msg.arrangement;
                                document.getElementById('hud-arrangement').textContent = arrLabel;

                                const hudTuningEl = document.getElementById('hud-tuning');
                                const hudTargetsEl = document.getElementById('hud-tuning-targets');
                                const tuningLabel = (typeof window.displayTuningName === 'function')
                                    ? window.displayTuningName(null, msg.tuning)
                                    : '';
                                if (hudTuningEl) {
                                    hudTuningEl.textContent = tuningLabel ? ('Tuning: ' + tuningLabel) : '';
                                }
                                if (hudTargetsEl) {
                                    let targetsText = '';
                                    if (tuningLabel === 'Custom Tuning'
                                            && Array.isArray(msg.tuning) && msg.tuning.length
                                            && typeof window.displayTuningTargets === 'function') {
                                        const targets = window.displayTuningTargets(msg.tuning, {
                                            stringCount: msg.stringCount,
                                            arrangement: msg.arrangement,
                                            arrangement_smart_name: msg.arrangement_smart_name,
                                            tuningName: tuningLabel,
                                        });
                                        targetsText = targets ? ('Targets: ' + targets) : '';
                                    }
                                    hudTargetsEl.textContent = targetsText;
                                }
    
                                // Clear any lingering audio-error banner from a prior song.
                                const existingAudioErr = document.getElementById('audio-error-banner');
                                if (existingAudioErr) existingAudioErr.remove();
    
                                // Server reported a concrete audio-pipeline failure and has
                                // no URL to give us — surface it instead of leaving the
                                // user with a cryptic "Empty src attribute" from audio.play().
                                if (!msg.audio_url && msg.audio_error) {
                                    _reportAudioRoute('unknown', 'unavailable', msg.audio_error);
                                    const banner = document.createElement('div');
                                    banner.id = 'audio-error-banner';
                                    banner.className = 'fixed top-4 left-1/2 -translate-x-1/2 z-[300] bg-red-900/95 border border-red-700 text-red-100 rounded-lg px-4 py-3 max-w-2xl shadow-xl';
                                    banner.innerHTML = `
                                        <div class="flex items-start gap-3">
                                            <span class="text-xl leading-none">⚠</span>
                                            <div class="flex-1">
                                                <div class="font-semibold text-sm">Audio unavailable</div>
                                                <div class="text-xs text-red-200 mt-1"></div>
                                            </div>
                                            <button class="text-red-300 hover:text-white text-lg leading-none" aria-label="Dismiss">✕</button>
                                        </div>`;
                                    banner.querySelector('.text-xs').textContent = msg.audio_error;
                                    banner.querySelector('button').addEventListener('click', () => banner.remove());
                                    document.body.appendChild(banner);
                                }
    
                                if (msg.audio_url) {
                                    const audio = document.getElementById('audio');
                                    const audioFilename = msg.audio_url.split('/').pop();
                                    // /audio/ URLs are always JUCE-routable. A feedpak full-mix
                                    // (single-mix pack: original audio, no stems) is routable too,
                                    // but ONLY under an exclusive-style output — the actual
                                    // exclusive check happens at routing time (app.js watcher /
                                    // the async block below), not here, because the share mode
                                    // can change while the song is loaded. Sloppak stem URLs are
                                    // never routable.
                                    const isAudioUrl = msg.audio_url.startsWith('/audio/');
                                    // "Full mix" covers BOTH single-mix pack shapes:
                                    //  - stem-less packs (original_audio: in the manifest,
                                    //    audio_url == original_audio_url), and
                                    //  - single-stem packs (stems: [full.ogg] only) — the server
                                    //    puts the full mix in the stems list, has_original_audio
                                    //    is false, and audio_url points at the one stem. With one
                                    //    stem there is no per-stem mix to preserve, so routing it
                                    //    natively loses nothing. Real multi-stem (>1) stays out
                                    //    until Phase 2.
                                    const isFeedpakFullMix = !isAudioUrl
                                        && msg.audio_url.startsWith('/api/sloppak/')
                                        && ((!!msg.has_original_audio && !msg.has_stems)
                                            || (msg.stems || []).length === 1);
                                    // Record the loaded song's audio so app.js can re-route it
                                    // between the HTML5 and JUCE paths if the audio engine is
                                    // started/stopped after the song is already loaded. Set this
                                    // unconditionally (not just on reload): when alreadyLoaded is
                                    // true the watcher must still see correct, current metadata.
                                    window._currentSongAudio = {
                                        url: msg.audio_url,
                                        juceEligible: isAudioUrl,
                                        feedpakFullMix: isFeedpakFullMix,
                                    };
                                    const alreadyLoaded = window._juceMode
                                        ? window._juceAudioUrl === msg.audio_url
                                        : (audio.src && audio.src.includes(audioFilename));
                                    // [feedpak-route] diagnostics: every eligibility input in one
                                    // line — shows up in the exported diagnostics bundle. If
                                    // has_stems is true the pack is multi-stem and Phase 1
                                    // deliberately does not route it (Phase 2 work).
                                    console.log('[feedpak-route] song-load:',
                                        'url=', msg.audio_url,
                                        'isAudioUrl=', isAudioUrl,
                                        'isFeedpakFullMix=', isFeedpakFullMix,
                                        'has_stems=', !!msg.has_stems,
                                        'stems=', (msg.stems || []).length,
                                        'has_original_audio=', !!msg.has_original_audio,
                                        'format=', msg.format,
                                        'alreadyLoaded=', alreadyLoaded,
                                        'juceApi=', !!window.feedBackDesktop?.audio);
                                    if (!alreadyLoaded) {
                                        const juceApi = window.feedBackDesktop?.audio;
                                        if ((isAudioUrl || isFeedpakFullMix) && juceApi) {
                                            // Run JUCE routing off the critical message-processing chain
                                            // so subsequent notes/chords/ready messages aren't blocked
                                            // waiting for IPC + HTTP round-trips. The 'ready' handler
                                            // awaits _juceRoutingPromise so _juceMode is settled before
                                            // _onReady / song:ready fire.
                                            const audioUrl = msg.audio_url;
                                            // Flag the initial song-load JUCE routing as in-flight so the
                                            // app.js engine-reroute watcher stands down until _juceMode is
                                            // settled — otherwise its 350ms poll could race this routing
                                            // and double-call loadBackingTrack for the same URL.
                                            window._highwayJuceRoutingPending = true;
                                            hwState._juceRoutingPromise = (async () => {
                                                let pathLabel = '<missing>';
                                                try {
                                                    // Wait out any in-flight native-audio reconfiguration (e.g.
                                                    // a NAM tone graph build that restarts the audio device)
                                                    // before touching the JUCE backing engine — otherwise the
                                                    // device restart races the backing-track load (and an
                                                    // isAudioRunning() check landing mid-restart would skip
                                                    // backing entirely). Raced against a local 3s timeout so a
                                                    // plugin barrier that never settles cannot wedge song entry;
                                                    // the try/catch + Promise.resolve wrapper also covers a
                                                    // synchronous throw from the barrier call.
                                                    if (typeof window.feedBackAudioBarrier === 'function') {
                                                        let barrierTimer;
                                                        let barrierTimedOut = false;
                                                        try {
                                                            await Promise.race([
                                                                Promise.resolve().then(() => window.feedBackAudioBarrier()),
                                                                new Promise((r) => { barrierTimer = setTimeout(() => { barrierTimedOut = true; r(); }, 3000); }),
                                                            ]);
                                                            _reportAudioMonitoring('juce-audio-barrier', barrierTimedOut ? 'unavailable' : 'active', barrierTimedOut ? 'Audio barrier timed out before native route setup' : '');
                                                            _reportAudioBridge('audio-monitoring.audio-barrier', 'audio-monitoring', 'window.feedBackAudioBarrier', barrierTimedOut ? 'degraded' : 'handled', barrierTimedOut ? 'Audio barrier timed out before native route setup' : '');
                                                        } catch (_) {
                                                            _reportAudioMonitoring('juce-audio-barrier', 'failed', 'Audio barrier failed before native route setup');
                                                            _reportAudioBridge('audio-monitoring.audio-barrier', 'audio-monitoring', 'window.feedBackAudioBarrier', 'failed', 'Audio barrier failed before native route setup');
                                                        }
                                                        // Promise.race doesn't cancel the loser — clear the timer
                                                        // when the barrier wins so rapid song switches don't leak.
                                                        clearTimeout(barrierTimer);
                                                        if (gen !== hwState._wsGen) return; // navigated away during the wait
                                                    }
                                                    // Feedpak full-mix rides the engine ONLY under an
                                                    // exclusive-style output (shared mode falls through to
                                                    // the HTML5 fallback below, keeping the WebAudio path
                                                    // fully working). /audio/ songs route whenever the
                                                    // engine runs, as before. If the share mode changes
                                                    // later, the app.js watcher re-evaluates and migrates.
                                                    let routeToJuce = await juceApi.isAudioRunning();
                                                    console.log('[feedpak-route] initial-load: engineRunning=', routeToJuce);
                                                    if (routeToJuce) {
                                                        if (gen !== hwState._wsGen) return; // stale
                                                        if (isFeedpakFullMix) {
                                                            const exclFn = window._juceOutputIsExclusive;
                                                            routeToJuce = !!(await exclFn?.());
                                                            console.log('[feedpak-route] initial-load: feedpak exclusive check →',
                                                                routeToJuce, '(predicate installed=', typeof exclFn === 'function', ')');
                                                        }
                                                    }
                                                    if (routeToJuce) {
                                                        if (gen !== hwState._wsGen) return; // stale
                                                        const res = await fetch(`/api/audio-local-path?url=${encodeURIComponent(audioUrl)}`);
                                                        if (!res.ok) throw new Error('HTTP ' + res.status);
                                                        const { path } = await res.json();
                                                        pathLabel = (typeof path === 'string' && path.split(/[\\/]/).pop()) || '<missing>';
                                                        const ok = await juceApi.loadBackingTrack(path);
                                                        console.log('[highway] JUCE loadBackingTrack file=', pathLabel, 'ok=', ok);
                                                        if (ok === false) throw new Error('JUCE rejected backing track: ' + pathLabel);
                                                        if (gen !== hwState._wsGen) return; // stale
                                                        if (window.jucePlayer) window.jucePlayer._dur = await juceApi.getBackingDuration();
                                                        if (gen !== hwState._wsGen) return; // stale
                                                        window._juceMode = true;
                                                        window._juceAudioUrl = audioUrl;
                                                        _reportAudioRoute('juce', 'available');
                                                        // Re-apply the active Song fader whenever a new backing
                                                        // track is loaded so song-to-song switches keep the same
                                                        // user-selected level instead of the engine default.
                                                        try {
                                                            const apply = window.feedBack?.audio?.applySongVolume;
                                                            if (typeof apply === 'function') {
                                                                await apply();
                                                            } else {
                                                                // audio-mixer.js registers applySongVolume but is
                                                                // loaded after highway.js in index.html. In JUCE
                                                                // mode the HTML5 <audio> element is cleared, so
                                                                // there is no later `loadedmetadata` event to
                                                                // correct an unset gain. Read the persisted volume
                                                                // and call juceApi.setGain directly so the backing
                                                                // gain matches the user-selected level even when
                                                                // the mixer module hasn't registered yet.
                                                                let storedPct = 80;
                                                                try {
                                                                    const s = parseFloat(localStorage.getItem('volume'));
                                                                    if (Number.isFinite(s)) storedPct = Math.min(100, Math.max(0, s));
                                                                } catch (_) { /* localStorage may be blocked */ }
                                                                if (typeof juceApi.setGain === 'function') {
                                                                    try { await juceApi.setGain('backing', storedPct / 100); } catch (_) { /* IPC unavailable */ }
                                                                }
                                                            }
                                                        } catch (gainErr) {
                                                            console.warn('[highway] JUCE setGain backing failed', gainErr);
                                                        }
                                                        if (gen !== hwState._wsGen) return; // stale
                                                        // Clear the HTML5 element so it does not buffer an unused track
                                                        audio.src = '';
                                                        return;
                                                    }
                                                } catch (err) {
                                                    console.warn('[highway] JUCE audio routing failed, falling back to HTML5 file=', pathLabel, err);
                                                    if (gen !== hwState._wsGen) return; // stale
                                                    window._juceMode = false;
                                                    window._juceAudioUrl = null;
                                                    _reportAudioRoute('html5', 'degraded', err && err.message ? err.message : String(err));
                                                }
                                                // HTML5 fallback (isAudioRunning false, or JUCE error)
                                                if (gen !== hwState._wsGen) return; // stale
                                                window._juceMode = false;
                                                window._juceAudioUrl = null;
                                                audio.src = audioUrl;
                                                _reportAudioRoute('html5', pathLabel === '<missing>' ? 'available' : 'degraded', pathLabel === '<missing>' ? '' : 'JUCE fallback');
                                                if (typeof window.feedBack?.audio?.applySongVolume === 'function') {
                                                    void window.feedBack.audio.applySongVolume();
                                                }
                                                audio.load();
                                                _showAudioBufferingOverlay(audio);
                                            })().finally(() => {
                                                // Initial routing settled (success, fallback, or stale
                                                // bail) — release the app.js engine-reroute watcher.
                                                // Only clear if this is still the live connection: a
                                                // stale finally from a previous song must not release
                                                // the gate for a newer in-flight load (which has its
                                                // own pending=true and will clear its own finally).
                                                if (gen === hwState._wsGen) {
                                                    window._highwayJuceRoutingPending = false;
                                                }
                                            });
                                        } else {
                                            // Non-JUCE path: sloppak stems, or no JUCE API present.
                                            // This branch does NOT set/clear
                                            // window._highwayJuceRoutingPending — that gate guards
                                            // only the async JUCE-routing branch above. This path is
                                            // synchronous and brief, so the app.js reroute watcher
                                            // running concurrently here is harmless.
                                            window._juceMode = false;
                                            window._juceAudioUrl = null;
                                            audio.src = msg.audio_url;
                                            _reportAudioRoute(isAudioUrl ? 'html5' : 'stems', 'available');
                                            if (typeof window.feedBack?.audio?.applySongVolume === 'function') {
                                                void window.feedBack.audio.applySongVolume();
                                            }
                                            audio.load();
                                            _showAudioBufferingOverlay(audio);
                                        }
                                    }
                                }
                                // Populate arrangement dropdown
                                if (msg.arrangements) {
                                    const sel = document.getElementById('arr-select');
                                    // Server-echoed naming_mode preferred; see HUD branch above.
                                    let namingMode = msg.naming_mode;
                                    if (namingMode !== 'smart' && namingMode !== 'legacy') {
                                        try { namingMode = localStorage.getItem('arrangementNamingMode') === 'legacy' ? 'legacy' : 'smart'; } catch (_) { namingMode = 'smart'; }
                                    }
                                    sel.textContent = '';
                                    for (const a of msg.arrangements) {
                                        const displayName = (namingMode === 'smart' && a.smart_name) ? a.smart_name : a.name;
                                        // Keep the note-count suffix in both modes — useful for
                                        // disambiguating sibling arrangements (e.g. two "Alt. Lead"s).
                                        const label = `${displayName} (${a.notes})`;
                                        const opt = document.createElement('option');
                                        opt.value = a.index;
                                        opt.selected = a.index === msg.arrangement_index;
                                        opt.textContent = label;
                                        sel.appendChild(opt);
                                    }
                                }
                            }
                            // Plugin context API — broadcast current song state
                            if (window.feedBack) {
                                const wsPath = hwState.ws.url.split('/ws/highway/')[1] || '';
                                const filename = decodeURIComponent(wsPath.split('?')[0]);
                                window.feedBack.currentSong = {
                                    filename,
                                    title: msg.title,
                                    artist: msg.artist,
                                    duration: msg.duration,
                                    arrangement: msg.arrangement,
                                    arrangementSmartName: msg.arrangement_smart_name ?? null,
                                    arrangementIndex: msg.arrangement_index,
                                    arrangements: msg.arrangements || [],
                                    tuning: msg.tuning,
                                    capo: msg.capo,
                                    format: msg.format,
                                    // True when the sloppak ships a drum_tab.json.
                                    // Lets the visualization picker auto-activate
                                    // the drums plugin even when the active
                                    // arrangement isn't named "Drums".
                                    hasDrumTab: Boolean(msg.has_drum_tab),
                                    // True when any arrangement carries a notation:
                                    // file (sloppak-spec §5.3). Notation viz plugins
                                    // (staff view, keys highway) gate their
                                    // matchesArrangement on this rather than the
                                    // arrangement name.
                                    hasNotation: Boolean(msg.has_notation),
                                    // Feedpak contributor credits (manifest
                                    // `authors:`, spec §5.4): [{name, role}].
                                    // Only real feedpak plays carry these; loose/
                                    // archive sources and synthetic highway uses
                                    // (minigames) get []. app.js shows a credits
                                    // overlay on song load when this is non-empty.
                                    authors: Array.isArray(msg.authors) ? msg.authors : [],
                                };
                                window.feedBack.emit('song:loaded', window.feedBack.currentSong);
                            }
                            break;
                        case 'beats':
                            hwState.beats = msg.data;
                            // Notify plugins that beats are now available so
                            // they don't have to poll highway.getBeats() in a
                            // setInterval to know when the WS finished
                            // streaming the beats array. Verify .emit is
                            // callable too — the namespace can be partially
                            // attached during early boot.
                            if (window.feedBack && typeof window.feedBack.emit === 'function') {
                                window.feedBack.emit('beats:loaded', { count: hwState.beats.length });
                            }
                            break;
                        case 'sections': hwState.sections = msg.data; break;
                        case 'anchors':
                            hwState.anchors = msg.data;
                            if (hwState.anchors.length) {
                                hwState.displayMaxFret = Math.max(hwState.anchors[0].fret + hwState.anchors[0].width + 3, 8);
                            }
                            break;
                        case 'chord_templates': hwState.chordTemplates = msg.data; break;
                        case 'lyrics':
                            hwState.lyrics = msg.data;
                            // Provenance: "xml" | "notechart" | "whisperx" | "user".
                            // Surfaced via the renderer bundle so visualization
                            // plugins can render an "auto-transcribed" badge
                            // (or any other source-dependent UI) without
                            // having to hook the raw WS themselves.
                            hwState.lyricsSource = msg.source || "";
                            break;
                        case 'tone_changes': hwState.toneChanges = msg.data; hwState.toneBase = msg.base || ""; break;
                        case 'notes': hwState.notes = hwState.notes.concat(msg.data); break;
                        case 'chords': hwState.chords = hwState.chords.concat(msg.data); break;
                        case 'handshapes': hwState.handShapes = hwState.handShapes.concat(msg.data); break;
                        case 'drum_tab':
                            // Metadata + kit legend arrive first; the hits
                            // come in 500-per-frame chunks below. Reset the
                            // hits array per `drum_tab` to defend against
                            // an arrangement-change replay on the same WS.
                            hwState.drumTab = {
                                version: Number.isInteger(msg.version) ? msg.version : 1,
                                name: (typeof msg.name === 'string' && msg.name) ? msg.name : 'Drums',
                                kit: Array.isArray(msg.kit) ? msg.kit : [],
                                hits: [],
                            };
                            break;
                        case 'drum_hits':
                            if (hwState.drumTab && Array.isArray(msg.data)) {
                                Array.prototype.push.apply(hwState.drumTab.hits, msg.data);
                            }
                            break;
                        case 'phrases':
                            // Accumulate chunks but DON'T rebuild the filter
                            // until `ready` — rebuilding per chunk would
                            // cause visual flicker (partial filtered array
                            // visible while later chunks are still arriving)
                            // and duplicate work.
                            if (hwState._phrases === null) hwState._phrases = [];
                            for (const p of msg.data) hwState._phrases.push(p);
                            break;
                        case 'ready':
                            hwState.ready = true;
                            if (hwState.handShapes.length) {
                                hwState.handShapes.sort((a, b) => a.start_time - b.start_time);
                            }
                            _rebuildMasteryFilter();
                            console.log(`Highway ready: ${hwState.notes.length} notes, ${hwState.chords.length} chords` +
                                `, ${hwState.handShapes.length} handShapes` +
                                (hwState._phrases !== null ? `, ${hwState._phrases.length} phrases (mastery ${Math.round(hwState._mastery * 100)}%)` : ""));
                            // Wait for the off-chain JUCE routing (if any) to settle
                            // so _juceMode is correctly set before _onReady and song:ready fire.
                            await hwState._juceRoutingPromise.catch(() => {});
                            if (!hwState.animFrame) draw();
                            if (api._onReady) await Promise.resolve(api._onReady()).catch((err) => console.error('[highway] _onReady error:', err));
                            // Broadcast to interested listeners (e.g. the
                            // difficulty-slider disabled-state update in
                            // app.js). Fires on every `ready`, including
                            // arrangement switches — unlike `_onReady`,
                            // which is a single-use callback slot.
                            if (window.feedBack) {
                                // Reuse api.hasPhraseData so the emit and
                                // the public getter agree on the sentinel.
                                window.feedBack.emit('song:ready', {
                                    hasPhraseData: api.hasPhraseData(),
                                });
                            }
                            break;
                    }
                    } catch (err) {
                        console.error('[highway] ws.onmessage error:', err);
                    }
                }).catch((err) => { console.error('[highway] message chain error:', err); });
            };
        },

        setTime(t) {
            // chartTime is what getTime() exposes to plugins — bake the
            // per-song offset in here so plugins (scoring, note detect,
            // etc.) see the same chart-aligned clock the renderer does.
            hwState.chartTime = t + hwState.songOffset;
            hwState.currentTime = hwState.chartTime + hwState.avOffsetSec;
            // Only re-anchor on a genuinely new audio time. Repeated
            // calls with the same `t` (audio.currentTime hasn't updated
            // yet) keep the anchor's perfNow fixed so interpolation
            // continues smoothly between audio updates. Tracking
            // _chartLastAdvanceAt here too lets getTime() detect when
            // the audio clock has stalled (= paused) without coupling
            // to song:* events.
            if (t !== hwState._chartAnchorAudioT) {
                const newPerfNow = performance.now();
                // Derive observed rate from this anchor segment so
                // interpolation respects speed slider changes (and
                // any DSP-induced rate drift). Skip refresh on the
                // initial anchor (no prior segment) and on near-zero
                // dt (would divide by ~0). Clamp to a sane window so
                // a noisy seek doesn't poison the estimate.
                const hadPriorAnchor = !Number.isNaN(hwState._chartAnchorPerfNow);
                const dPerf = hadPriorAnchor ? (newPerfNow - hwState._chartAnchorPerfNow) / 1000 : 0;
                if (hadPriorAnchor && dPerf > 0.001 && dPerf < 0.5) {
                    const observed = (t - hwState._chartAnchorAudioT) / dPerf;
                    if (observed > 0.05 && observed < 5) {
                        hwState._chartObservedRate = observed;
                    } else {
                        // Out-of-band rate (seek discontinuity, loop wrap,
                        // negative jump back). We can't measure rate from
                        // this segment, so reset to 1 instead of carrying
                        // a stale estimate from the prior segment.
                        hwState._chartObservedRate = 1;
                    }
                } else if (hadPriorAnchor && dPerf >= 0.5) {
                    // Long gap between anchor updates — anchor was stale
                    // (paused, tab inactive, seek). Same reset.
                    hwState._chartObservedRate = 1;
                }
                hwState._chartAnchorAudioT = t;
                hwState._chartAnchorPerfNow = newPerfNow;
                hwState._chartLastAdvanceAt = newPerfNow;
            }
        },
        setAvOffset(ms) { hwState.avOffsetSec = (Number(ms) || 0) / 1000; hwState.currentTime = hwState.chartTime + hwState.avOffsetSec; },
        getAvOffset() { return hwState.avOffsetSec * 1000; },

        getBPM(t) {
            // Calculate BPM from beat intervals near time t
            if (hwState.beats.length < 2) return 120;
            let closest = 0;
            for (let i = 1; i < hwState.beats.length; i++) {
                if (Math.abs(hwState.beats[i].time - t) < Math.abs(hwState.beats[closest].time - t)) closest = i;
            }
            // Average interval from nearby beats
            const start = Math.max(0, closest - 2);
            const end = Math.min(hwState.beats.length - 1, closest + 2);
            let sum = 0, count = 0;
            for (let i = start; i < end; i++) {
                sum += hwState.beats[i + 1].time - hwState.beats[i].time;
                count++;
            }
            return count > 0 ? 60 / (sum / count) : 120;
        },

        getBeats() { return hwState.beats; },
        // Returns the chart clock smoothed via performance.now()
        // interpolation while audio is actively advancing — sub-frame
        // accurate even though audio.currentTime updates only ~every
        // 23 ms. When audio is paused/stalled (setTime keeps being
        // called with the same t for >100 ms), returns raw chartTime
        // so plugins don't see a clock drifting forward against silent
        // audio.
        getTime() {
            // No anchor yet (called before the first setTime, e.g. during
            // early boot before the 60 Hz tick has fired): just return
            // chartTime. Without this guard, elapsedMs would be NaN and
            // the rate-scaled return would propagate NaN to plugins.
            if (Number.isNaN(hwState._chartAnchorPerfNow)) return hwState.chartTime;
            const nowP = performance.now();
            // If t hasn't advanced for a while, audio is paused or the
            // tick has stopped — trust the raw chartTime.
            if (nowP - hwState._chartLastAdvanceAt > _CHART_MAX_INTERP_MS) return hwState.chartTime;
            const elapsedMs = nowP - hwState._chartAnchorPerfNow;
            // Same cap as a backstop for the "long main-thread task"
            // case — audio briefly advanced just before the stall, so
            // we'd interpolate beyond what reality permits.
            if (elapsedMs > _CHART_MAX_INTERP_MS) return hwState.chartTime;
            // Scale by the observed playback rate so getTime stays
            // accurate across slowdowns / speedups (audio.playbackRate
            // != 1 is a first-class feedBack feature). Add songOffset
            // so interpolated chart time stays consistent with the
            // chartTime that setTime() / the early-return branches
            // expose — anchors are stored in raw audio time, so the
            // offset is applied on the way out.
            return hwState._chartAnchorAudioT + (hwState._chartObservedRate * elapsedMs) / 1000 + hwState.songOffset;
        },
        // Returns the feedBack <audio> element so plugins don't have to
        // reach for `document.getElementById('audio')` directly. In JUCE
        // mode the same element is shimmed: `audio.currentTime` reads
        // jucePlayer's clock and writes go through the seek queue, and
        // `audio.play/pause` route to the JUCE backing engine — so the
        // returned element behaves uniformly regardless of mode.
        getAudioElement() {
            if (typeof window !== 'undefined' && !hwState._audioElementBridgeRecorded) {
                const playback = window.feedBack && window.feedBack.playback;
                if (playback && typeof playback.recordBridgeHit === 'function') {
                    // Consume the one-shot before recording so a reentrant poll
                    // during the synchronous bridge-hit emit can't double-record;
                    // reset it if recordBridgeHit throws so a failed record (and
                    // an early call before the domain is ready) still retries.
                    hwState._audioElementBridgeRecorded = true;
                    try {
                        playback.recordBridgeHit({
                            bridgeId: 'playback.audio-element-shim',
                            legacySurface: 'highway.getAudioElement',
                            source: 'core.highway',
                            reason: 'legacy audio element bridge requested',
                        });
                    } catch (_) {
                        hwState._audioElementBridgeRecorded = false;
                    }
                }
            }
            return document.getElementById('audio');
        },
        // Force the highway's visibility state for the rAF skip
        // (#246). Pass `true` or `false` to override; pass `null` to
        // clear the override and resume DOM-based detection via
        // canvas.offsetParent. Useful for hosts that hide the highway
        // via `visibility:hidden`, `opacity:0`, transforms, or other
        // means that offsetParent doesn't catch. Emits any resulting
        // transition immediately rather than waiting for the next
        // rAF tick.
        setVisible(v) {
            hwState._visibleOverride = (v === null || v === undefined) ? null : !!v;
            // Clearing the override resumes DOM-based detection — force a
            // fresh offsetParent sample so the resulting transition (if
            // any) emits now, not after the throttle window.
            if (hwState._visibleOverride === null) hwState._domVisSampledFrame = NaN;
            _emitVisibilityIfChanged();
        },
        // Snapshot of the current visibility state (the override if
        // set, else the live DOM check). Renderers that bind to
        // `highway:visibility` after a transition has already happened
        // can call this once to sync their initial state — the event
        // is transition-only and won't re-fire for late subscribers.
        isVisible() {
            // Force a fresh DOM sample — this is a documented "live DOM
            // check" for late subscribers seeding initial state, so it
            // must not serve the rAF loop's throttled cache (up to
            // ~166 ms stale). Called rarely; the layout-read cost that
            // motivated the throttle only matters per-frame.
            hwState._domVisSampledFrame = NaN;
            return _isHighwayVisible();
        },
        getNotes() { return hwState.notes; },
        getChords() { return hwState.chords; },
        // Difficulty-filtered variants of getNotes()/getChords(). Returns the
        // master-difficulty-filtered arrays when the current song has phrase-level
        // data (i.e. the mastery slider is active). For songs with a single
        // difficulty level the slider is disabled and _filteredNotes is null —
        // these fall through to the raw arrays, the same as getNotes()/getChords().
        // Plugins that score or analyse only the notes the player is currently
        // expected to play should prefer these over getNotes()/getChords(). Read-only.
        getFilteredNotes()  { return hwState._filteredNotes  !== null ? hwState._filteredNotes  : hwState.notes;  },
        getFilteredChords() { return hwState._filteredChords !== null ? hwState._filteredChords : hwState.chords; },
        // Live reference to the chord-template lookup table —
        // `getChords()[i].id` is an index into this array. Each
        // template carries `{ name, fingers, frets }`:
        //   - name:    chord name string ("Em", "Cmaj7", …)
        //   - fingers: per-string finger numbers (length matches
        //              the tuning's string count; -1 = unused, 0 =
        //              open string, n > 0 = finger number). arrangement XML
        //              sources populate real values; GP imports
        //              currently emit all -1.
        //   - frets:   per-string fret numbers, same indexing.
        // Read-only: overlay plugins should NOT mutate the array or
        // its entries. Not difficulty-filter-aware (templates are
        // static metadata; every chord_id referenced by `getChords()`
        // is guaranteed valid).
        getChordTemplates() { return hwState.chordTemplates; },
        getToneChanges() { return hwState.toneChanges; },
        getToneBase() { return hwState.toneBase; },
        getSections() { return hwState.sections; },
        // Timed lyric syllables for the active song: [{t: start, d: length,
        // w: word}], same array the highway WS populates. Exposed so overlay
        // plugins (e.g. stream_kit vocals) can render karaoke without a second
        // WS connection — mirrors getBeats()/getSections().
        getLyrics() { return hwState.lyrics; },
        // Phrase timing windows for plugins — `[{ index, start_time, end_time, max_difficulty }]`.
        // Returns null when the current song has no phrase data (GP imports, single-difficulty
        // charts). Gate phrase-aware logic with hasPhraseData() first. Read-only; do not mutate.
        getPhrases() {
            if (!hwState._phrases || !hwState._phrases.length) return null;
            return hwState._phrases.map((p, index) => ({
                index,
                start_time: p.start_time,
                end_time: p.end_time,
                max_difficulty: p.max_difficulty,
            }));
        },
        getSongInfo() { return hwState.songInfo; },
        // Number of strings on the active arrangement
        // (feedBack-plugin-3dhighway#7). 4 for bass, 6 for guitar,
        // 7+ for extended-range GP imports. Plugins should size
        // string-indexed UI / geometry against THIS rather than
        // assuming 6. Defaults to 6 between songs (until the next
        // song_info message arrives).
        getStringCount() { return hwState.stringCount; },
        addDrawHook(fn) {
            hwState._drawHooks.push(fn);
        },
        removeDrawHook(fn) { hwState._drawHooks = hwState._drawHooks.filter(h => h !== fn); },
        /**
         * Register a per-note judgment-state provider (feedBack#254).
         * `fn(note, chartTime)` is called by renderers for each visible
         * chart note and should return one of:
         *   - falsy → no special state (render normally)
         *   - 'hit'    — note was struck correctly (renderer lights the gem)
         *   - 'active' — a sustained note is currently being held correctly
         *   - 'miss'   — note was missed (renderer may red-wash the gem)
         *   - { state: <one of the above>, alpha?: 0..1, color?: '#rrggbb' }
         * The provider owns all timing/fade: return a decaying `alpha` for
         * a struck-note glow, `alpha: 1` (or a bare string) for a held
         * sustain, and stop returning state when the effect should end.
         * `note` is the chart note object; for chord notes `chartTime` is
         * the chord's time (so a `${time}_${s}_${f}` keyed lookup works).
         * Pass `null` to clear. Only one provider is active at a time.
         * Custom renderers read the same data via `bundle.getNoteState`.
         */
        setNoteStateProvider(fn) { hwState._noteStateProvider = (typeof fn === 'function') ? fn : null; },
        getNoteStateProvider() { return hwState._noteStateProvider; },
        /** Current per-string base colors (copy). Index 0..7. */
        getStringColors() { return hwState.STRING_COLORS.slice(); },
        /**
         * Override per-string colors for the "Highway String Colors" theme.
         * `arr` is an array of up to 8 hex strings; each provided entry sets
         * the base color and derives its dim (behind-gem) and bright (lit/hit)
         * variants. Missing/invalid indices fall back to the built-in default.
         * Pass null/[] to reset all strings to defaults. The RAF draw loop
         * picks up the new arrays on the next frame — no explicit redraw needed.
         */
        setStringColors(arr) {
            for (let i = 0; i < DEFAULT_STRING_COLORS.length; i++) {
                const hex = (arr && arr[i]) ? _parseHex(arr[i]) : null;
                if (hex) {
                    const base = _toHex(hex.r, hex.g, hex.b);
                    hwState.STRING_COLORS[i] = base;
                    hwState.STRING_DIM[i] = _darken(base, 0.40);
                    hwState.STRING_BRIGHT[i] = _lighten(base, 0.30);
                } else {
                    hwState.STRING_COLORS[i] = DEFAULT_STRING_COLORS[i];
                    hwState.STRING_DIM[i] = DEFAULT_STRING_DIM[i];
                    hwState.STRING_BRIGHT[i] = DEFAULT_STRING_BRIGHT[i];
                }
            }
        },
        /** Resolve the registered provider for one note (normalized). */
        getNoteState(note, chartTime) { return _noteState(hwState, note, chartTime); },
        /**
         * Fire all registered draw hooks on the given 2D context.
         * Custom renderers (e.g. the 3D highway) that maintain their own
         * 2D overlay canvas should call this after each frame so overlay
         * plugins that use addDrawHook() keep working regardless of which
         * renderer is active.
         */
        fireDrawHooks(ctx, W, H) {
            for (const hook of hwState._drawHooks) {
                try { hook(ctx, W, H); } catch (e) { /* ignore */ }
            }
        },
        project(tOffset) { return project(tOffset); },
        fretX(fret, scale, w) { return fretX(hwState, fret, scale, w); },

        /** Use when drawing text inside the lefty mirror; noop when not lefty. */
        fillTextUnmirrored(text, x, y) { fillTextReadable(hwState, text, x, y); },

        toggleLyrics() {
            hwState.showLyrics = !hwState.showLyrics;
            localStorage.setItem('showLyrics', String(hwState.showLyrics));
            if (hwState._onLyricsChange) hwState._onLyricsChange(hwState.showLyrics);
        },

        getLyricsVisible() { return hwState.showLyrics; },
        // Provenance of the active lyric set. See `lyricsSource` declaration
        // for the full enum. Plugins consume this to badge auto-transcribed
        // (whisperx) lyrics differently from authored (xml/notechart/user) ones.
        getLyricsSource() { return hwState.lyricsSource; },
        setLyricsVisible(v) {
            hwState.showLyrics = !!v;
            if (hwState._onLyricsChange) hwState._onLyricsChange(hwState.showLyrics);
        },
        setOnLyricsChange(fn) { hwState._onLyricsChange = fn; },

        // Teaching marks (§6.2.2): toggle the opt-in sd/ch overlays. The fg
        // numeral has its own toggle below. Persisted to localStorage.
        getTeachingMarksVisible() { return hwState._showTeachingMarks; },
        toggleTeachingMarks() {
            hwState._showTeachingMarks = !hwState._showTeachingMarks;
            localStorage.setItem('showTeachingMarks', String(hwState._showTeachingMarks));
        },
        setTeachingMarksVisible(v) {
            hwState._showTeachingMarks = !!v;
            localStorage.setItem('showTeachingMarks', String(hwState._showTeachingMarks));
        },

        // Fret-hand finger hints (§6.2.2 fg): shown by default, hideable
        // independently of the sd/ch overlays. Persisted to localStorage.
        getFingerHintsVisible() { return hwState._showFingerHints; },
        toggleFingerHints() {
            hwState._showFingerHints = !hwState._showFingerHints;
            localStorage.setItem('showFingerHints', String(hwState._showFingerHints));
        },
        setFingerHintsVisible(v) {
            hwState._showFingerHints = !!v;
            localStorage.setItem('showFingerHints', String(hwState._showFingerHints));
        },

        reconnect(filename, arrangement) {
            // Close old WS but keep audio + animation running
            if (hwState.ws) { hwState.ws.close(); hwState.ws = null; }
            hwState.ready = false;
            hwState.notes = []; hwState.chords = []; hwState.handShapes = []; hwState.beats = []; hwState.sections = []; hwState.anchors = []; hwState.chordTemplates = []; hwState.lyrics = []; hwState.lyricsSource = ""; hwState.toneChanges = []; hwState.toneBase = ""; hwState.drumTab = null;
            hwState.stringCount = 6;  // default until song_info arrives
            // Drop any per-song offset from the previous load so setTime
            // calls that fire before the next song_info arrives don't
            // bias the clock with stale data.
            hwState.songOffset = 0.0;
            // Reset phrase ladder + filter (feedBack#48). _mastery
            // persists across arrangement switches — the slider's
            // position stays put. Filter rebuilds on the next `ready`
            // once the new arrangement's phrases arrive (or stays
            // disabled if the new source has no phrase data).
            hwState._phrases = null;
            hwState._filteredNotes = null;
            hwState._filteredChords = null;
            hwState._filteredAnchors = null;
            hwState._filteredHandShapes = null;
            hwState._phrasesHaveHandShapes = false;
            _resetChordRenderState();
            const wsParams = new URLSearchParams();
            if (arrangement !== undefined) wsParams.set('arrangement', arrangement);
            let namingMode = 'smart';
            if (typeof window._getArrangementNamingMode === 'function') {
                const v = window._getArrangementNamingMode();
                if (v === 'smart' || v === 'legacy') namingMode = v;
            } else {
                try {
                    const v = localStorage.getItem('arrangementNamingMode');
                    if (v === 'smart' || v === 'legacy') namingMode = v;
                } catch (_) {}
            }
            wsParams.set('naming_mode', namingMode);
            const qs = wsParams.toString();
            // filename might already be encoded from data-play attribute
            const decoded = decodeURIComponent(filename);
            const wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/highway/${decoded}${qs ? '?' + qs : ''}`;
            console.log('reconnect:', wsUrl);
            this.connect(wsUrl, hwState._connectOpts);
        },

        stop() {
            if (hwState.animFrame) { cancelAnimationFrame(hwState.animFrame); hwState.animFrame = null; }
            // Tear down the perf HUD explicitly: the rAF loop (which otherwise
            // removes it when the flag flips off) is about to stop, so leaving
            // it would strand the overlay in the DOM until a page reload.
            if (hwState._perfHud) { hwState._perfHud.remove(); hwState._perfHud = null; }
            // Reset per-session adaptive-scale + HUD accumulators so a quick
            // stop→init can't inherit stale performance.now() anchors (which
            // would skip the next paused session's first draw or defer a
            // HUD-flag re-read), and so the next song re-adapts from the
            // user's manual scale rather than the last session's auto level. (#654)
            hwState._autoScale = 1;
            hwState._drawMsEMA = 0;
            hwState._lastAutoAdjustAt = 0;
            hwState._lastPausedDrawAt = 0;
            hwState._frameMsEMA = 0;
            hwState._lastFramePerf = 0;
            hwState._hudOn = false;
            hwState._hudFlagAt = 0;
            if (hwState.ws) { hwState.ws.close(); hwState.ws = null; }
            hwState.songOffset = 0.0;  // reset per-song offset so next song starts clean
            if (hwState._resizeHandler) {
                window.removeEventListener('resize', hwState._resizeHandler);
                hwState._resizeHandler = null;
            }
            // No song:* listeners to tear down — the monotonic clock
            // detects pause via setTime call patterns, not events.
            // Reset the anchor state so a fresh init/connect cycle
            // doesn't see stale advance timestamps from the previous
            // session, and reset the observed rate to the 1x default.
            hwState._chartAnchorAudioT = NaN;
            hwState._chartAnchorPerfNow = NaN;
            hwState._chartLastAdvanceAt = 0;
            hwState._chartObservedRate = 1;
            // Release the renderer's GPU / DOM / event-listener resources
            // when leaving the player — anything it allocated in init()
            // should be torn down here so navigating away doesn't leak.
            // Crucially we KEEP `_renderer` (the instance/selection) so
            // that the next api.init() can re-apply the same visualization
            // on the new canvas. _rendererInited flips to false so
            // _setRenderer knows not to call destroy() again on this
            // already-destroyed instance.
            _destroyCurrentIfInited();
            hwState.ready = false;
            hwState.songInfo = {};
        },

        /**
         * Install a custom renderer. Contract (feedBack#36):
         *   r.init(canvas, bundle) — one-time setup; owns getContext().
         *   r.draw(bundle)         — per rAF frame.
         *   r.resize(w, h)         — optional; called when canvas dims change.
         *   r.destroy()            — optional; release resources.
         * Pass null or undefined to restore the default renderer.
         *
         * Custom renderers receive a data bundle (see _makeBundle) that
         * already applies the master-difficulty filter — the notes /
         * chords / anchors arrays are the right set to render regardless
         * of slider position. Use _drawHooks only for the default
         * renderer; they're a 2D-only contract.
         */
        setRenderer(r) { _setRenderer(r); },
        /**
         * True when the built-in 2D canvas highway is the active renderer
         * (or none has been installed yet — that resolves to the default
         * on init). Overlay plugins that draw with the 2D-highway
         * coordinate helpers (`project` / `fretX`) — note_detect's
         * miss markers, etc. — should check this and skip rendering when
         * a custom renderer (3D highway, piano, …) is active, since those
         * geometries don't match and the renderer owns that feedback
         * itself. Plugins that draw renderer-agnostic overlays (fretboard
         * diagram, chord-label HUD) don't need this.
         */
        isDefaultRenderer() { return hwState._renderer === _defaultRenderer || hwState._renderer == null; },
    };
    return api;
}
const highway = createHighway();
window.highway = highway; // expose for plugins

// THE FACTORY IS PART OF THE PUBLIC CONTRACT, and a classic script gave it to us for free.
//
// A top-level `function createHighway()` in a CLASSIC script implicitly becomes
// window.createHighway. In a MODULE it does not — module declarations are module-scoped, and
// the name would silently vanish from the global object the moment this file grew a
// type="module" attribute. The constitution names window.createHighway as public extension
// contract (alongside window.playSong / showScreen / feedBack), and plugins that render their
// own highway panel construct a second instance with it. Nothing in-tree calls it, which is
// exactly why this would have shipped: the only consumers are third-party, and I cannot grep
// those.
//
// So it is assigned explicitly now. Same object, same behaviour, no longer an accident of how
// the file happens to be loaded.
window.createHighway = createHighway;
highway.setOnLyricsChange(function(visible) {
    const btn = document.getElementById('btn-lyrics');
    if (btn) {
        btn.textContent = visible ? 'Lyrics \u2713' : 'Lyrics \u2717';
        btn.className = visible
            ? 'px-3 py-1.5 bg-purple-900/40 hover:bg-purple-900/60 rounded-lg text-xs text-purple-300 transition'
            : 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition';
    }
});
