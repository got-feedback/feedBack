// Behavioral tests for the renderer-audio bus feeder in static/app.js.
//
// The feeder (an IIFE, `_installRendererBusFeeder`) captures renderer-side
// song audio (stems-plugin WebAudio master, or the core <audio> element) and
// pushes it into the desktop engine's renderer bus while the output device is
// exclusive-style — the Phase 2 path for audio the native backing transport
// cannot carry. These tests extract that IIFE from source and exercise
// `window._reevaluateRendererBus` against fakes, covering: stems engagement
// under exclusive output, disengagement on return to shared mode, inertness
// in shared mode / while the native transport owns the song, and the
// element-capture fallback.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = path.join(__dirname, '..', '..', 'static', 'app.js');

function extractFeederIIFE(src) {
    const marker = '(function _installRendererBusFeeder() {';
    const start = src.indexOf(marker);
    assert.ok(start !== -1, 'feeder IIFE not found in app.js');
    const openBrace = src.indexOf('{', start);
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    assert.ok(depth === 0, 'unbalanced braces in feeder IIFE');
    const tail = src.slice(i, i + 5);
    assert.match(tail, /^\)\(\)/, 'feeder IIFE not immediately invoked');
    return src.slice(start, i) + ')();';
}

function makeFakeContext(sampleRate = 48000) {
    const ctx = {
        sampleRate,
        state: 'running',
        sinkIdCalls: [],
        destination: { isDestination: true },
        setSinkId(v) { this.sinkIdCalls.push(v); return Promise.resolve(); },
        resume() { this.state = 'running'; return Promise.resolve(); },
        audioWorklet: { addModule: () => Promise.resolve() },
        createMediaElementSource(el) {
            this.mediaSourceEl = el;
            return { connect() {}, disconnect() {} };
        },
        createMediaStreamSource(stream) {
            this.mediaStreamSource = stream;
            return { connect() {}, disconnect() {} };
        },
        close() { this.closed = true; return Promise.resolve(); },
    };
    return ctx;
}

// Fake getDisplayMedia stream for the loopback-capture path.
function makeLoopbackStream({ suppressed = true } = {}) {
    const stopped = [];
    const audioTrack = {
        kind: 'audio',
        stop() { stopped.push('audio'); },
        getSettings: () => (suppressed ? { suppressLocalAudioPlayback: true } : {}),
    };
    const videoTrack = { kind: 'video', stop() { stopped.push('video'); } };
    return {
        __stopped: stopped,
        getAudioTracks: () => [audioTrack],
        getVideoTracks: () => [videoTrack],
        getTracks: () => [videoTrack, audioTrack],
    };
}

// `displayMedia`: undefined → loopback capture unavailable (Docker sphere /
// old desktop main); a function → used as navigator.mediaDevices.getDisplayMedia.
function makeSandbox({ isAudioRunning = () => true, exclusive = () => true, displayMedia } = {}) {
    const calls = { setRendererBus: [], pushRendererAudio: [], setPageMuted: [] };

    const api = {
        isAudioRunning: () => Promise.resolve(isAudioRunning()),
        setRendererBus: (en, g) => { calls.setRendererBus.push([en, g]); return Promise.resolve(); },
        pushRendererAudio: (buf, rate) => { calls.pushRendererAudio.push([buf.length, rate]); },
        setPageMuted: (m) => { calls.setPageMuted.push(m); return Promise.resolve(m); },
    };

    class FakeWorkletNode {
        constructor() { this.port = { onmessage: null }; }
        connect() {}
        disconnect() {}
    }

    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        URL: { createObjectURL: () => 'blob:tap', revokeObjectURL() {} },
        Blob: class { constructor() {} },
        AudioWorkletNode: FakeWorkletNode,
        AudioContext: function () { const c = makeFakeContext(); sandbox.__createdContexts.push(c); return c; },
        WeakSet, WeakMap, Promise, Float32Array, Math,
        setInterval: () => 0,
        document: {
            hidden: false,
            addEventListener() {},
            getElementById: () => sandbox.__audioEl,
        },
        __createdContexts: [],
        __audioEl: { id: 'audio' },
        __calls: calls,
        navigator: { mediaDevices: displayMedia ? { getDisplayMedia: displayMedia } : {} },
        window: null,
    };
    sandbox.window = {
        feedBackDesktop: { audio: api },
        _juceOutputIsExclusive: () => Promise.resolve(exclusive()),
        _juceMode: false,
        _currentSongAudio: null,
        feedBack: { stems: {} },
    };
    sandbox.globalThis = sandbox;

    const src = fs.readFileSync(APP_JS, 'utf8');
    vm.createContext(sandbox);
    vm.runInContext(extractFeederIIFE(src), sandbox);
    assert.equal(typeof sandbox.window._reevaluateRendererBus, 'function',
        'feeder must expose window._reevaluateRendererBus');
    return sandbox;
}

function makeStemsGraph() {
    return {
        context: makeFakeContext(),
        masterNode: { connect() {}, disconnect() {} },
    };
}

// Surface-mode (stems/element) tests run WITHOUT getDisplayMedia: the first
// tick probes loopback, fails, and latches _loopbackUnavailable; the second
// tick exercises the fallback surface mode. This mirrors an old desktop main
// without the display-media handler.
async function reevaluateWithFallback(sb) {
    await sb.window._reevaluateRendererBus();   // loopback probe → unavailable
    await sb.window._reevaluateRendererBus();   // surface fallback
}

test('stems graph + exclusive output → bus enabled, stems ctx null-sinked (loopback unavailable)', async () => {
    const sb = makeSandbox({ exclusive: () => true });
    const graph = makeStemsGraph();
    sb.window.feedBack.stems.audioGraph = graph;

    await reevaluateWithFallback(sb);

    assert.deepEqual(sb.__calls.setRendererBus.at(-1), [true, 1.0], 'bus enabled');
    assert.equal(graph.context.sinkIdCalls.at(-1)?.type, 'none', 'stems ctx re-pointed at null sink');
});

test('output returns to shared → bus disabled, sink restored', async () => {
    let excl = true;
    const sb = makeSandbox({ exclusive: () => excl });
    const graph = makeStemsGraph();
    sb.window.feedBack.stems.audioGraph = graph;

    await reevaluateWithFallback(sb);
    excl = false;
    await sb.window._reevaluateRendererBus();

    assert.deepEqual(sb.__calls.setRendererBus.at(-1), [false, 0], 'bus disabled');
    assert.equal(graph.context.sinkIdCalls.at(-1), '', 'default sink restored');
});

test('stems graph + shared output → feeder stays off (no double audio)', async () => {
    const sb = makeSandbox({ exclusive: () => false });
    sb.window.feedBack.stems.audioGraph = makeStemsGraph();

    await sb.window._reevaluateRendererBus();

    assert.equal(sb.__calls.setRendererBus.length, 0, 'bus never touched in shared mode');
});

test('element song + exclusive → element captured into bus (loopback unavailable)', async () => {
    const sb = makeSandbox({ exclusive: () => true });
    sb.window._currentSongAudio = { url: '/api/sloppak/x.sloppak/file/stems/full.ogg' };
    sb.window._juceMode = false;

    await reevaluateWithFallback(sb);

    assert.equal(sb.__createdContexts.length, 1, 'capture context created');
    assert.equal(sb.__createdContexts[0].mediaSourceEl, sb.__audioEl, 'element source captured');
    assert.deepEqual(sb.__calls.setRendererBus.at(-1), [true, 1.0], 'bus enabled');
});

test('native-transport song, loopback unavailable → surface modes stay off', async () => {
    const sb = makeSandbox({ exclusive: () => true });
    sb.window._currentSongAudio = { url: '/audio/song.ogg' };
    sb.window._juceMode = true;

    await reevaluateWithFallback(sb);

    assert.ok(!sb.__calls.setRendererBus.some(([en]) => en === true),
        'bus never ENABLED (failed-probe cleanup may disable it)');
    assert.equal(sb.__createdContexts.length, 0, 'no capture context created');
});

test('stems graph replaced mid-engagement → re-engages on the new graph', async () => {
    const sb = makeSandbox({ exclusive: () => true });
    const g1 = makeStemsGraph();
    sb.window.feedBack.stems.audioGraph = g1;
    await reevaluateWithFallback(sb);

    const g2 = makeStemsGraph();
    sb.window.feedBack.stems.audioGraph = g2;
    await sb.window._reevaluateRendererBus();

    assert.equal(g2.context.sinkIdCalls.at(-1)?.type, 'none', 'new graph null-sinked');
    assert.deepEqual(sb.__calls.setRendererBus.at(-1), [true, 1.0], 're-enabled for new graph');
});

// ── Loopback mode (whole-app capture) ────────────────────────────────────────

test('exclusive output + loopback available → engages without any song loaded', async () => {
    const stream = makeLoopbackStream();
    const sb = makeSandbox({ exclusive: () => true, displayMedia: () => Promise.resolve(stream) });

    await sb.window._reevaluateRendererBus();

    assert.deepEqual(sb.__calls.setRendererBus.at(-1), [true, 1.0], 'bus enabled for whole session');
    assert.ok(stream.__stopped.includes('video'), 'unused video track stopped');
    assert.equal(sb.__createdContexts.at(-1)?.mediaStreamSource, stream, 'loopback stream captured');
    assert.equal(sb.__calls.setPageMuted.length, 0, 'suppress constraint honoured — no page mute');
});

test('loopback context is closed on disengage (no orphaned tap worklet)', async () => {
    let excl = true;
    const stream = makeLoopbackStream();
    const sb = makeSandbox({ exclusive: () => excl, displayMedia: () => Promise.resolve(stream) });

    await sb.window._reevaluateRendererBus();          // engage loopback
    const lbCtx = sb.__createdContexts.at(-1);
    assert.equal(lbCtx?.mediaStreamSource, stream, 'loopback engaged');
    assert.notEqual(lbCtx.closed, true, 'context live while engaged');

    excl = false;
    await sb.window._reevaluateRendererBus();          // disengage
    assert.equal(lbCtx.closed, true, 'loopback context closed on disengage');
    assert.ok(stream.__stopped.includes('audio'), 'capture stream stopped');
});

test('loopback preferred over stems when both available', async () => {
    const stream = makeLoopbackStream();
    const sb = makeSandbox({ exclusive: () => true, displayMedia: () => Promise.resolve(stream) });
    const graph = makeStemsGraph();
    sb.window.feedBack.stems.audioGraph = graph;

    await sb.window._reevaluateRendererBus();

    assert.equal(graph.context.sinkIdCalls.length, 0, 'stems ctx untouched — loopback owns capture');
    assert.equal(sb.__createdContexts.at(-1)?.mediaStreamSource, stream, 'loopback engaged');
});

test('suppressLocalAudioPlayback unsupported → page-mute fallback, unmuted on disengage', async () => {
    let excl = true;
    const stream = makeLoopbackStream({ suppressed: false });
    const sb = makeSandbox({ exclusive: () => excl, displayMedia: () => Promise.resolve(stream) });

    await sb.window._reevaluateRendererBus();
    assert.deepEqual(sb.__calls.setPageMuted, [true], 'page muted as fallback');

    excl = false;
    await sb.window._reevaluateRendererBus();
    assert.deepEqual(sb.__calls.setPageMuted, [true, false], 'page unmuted on disengage');
    assert.deepEqual(sb.__calls.setRendererBus.at(-1), [false, 0], 'bus disabled');
});

test('getDisplayMedia rejected → sticky fallback to surface modes', async () => {
    const sb = makeSandbox({
        exclusive: () => true,
        displayMedia: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
    });
    const graph = makeStemsGraph();
    sb.window.feedBack.stems.audioGraph = graph;

    await sb.window._reevaluateRendererBus();   // probe fails, latches unavailable
    await sb.window._reevaluateRendererBus();   // falls back to stems

    assert.equal(graph.context.sinkIdCalls.at(-1)?.type, 'none', 'stems fallback engaged');
    assert.deepEqual(sb.__calls.setRendererBus.at(-1), [true, 1.0], 'bus enabled via fallback');
});

test('element capture collision (createMediaElementSource throws) → no poisoned state, clean retry', async () => {
    const sb = makeSandbox({ exclusive: () => true });   // loopback unavailable
    sb.window._currentSongAudio = { url: '/api/sloppak/x.sloppak/file/stems/full.ogg' };
    // First capture attempt collides (highway analyser owns the element).
    let collide = true;
    const origFactory = sb.AudioContext;
    sb.__createdContexts.length = 0;
    // Patch contexts so createMediaElementSource throws while colliding.
    sb.AudioContext = function () {
        const c = origFactory();
        const orig = c.createMediaElementSource.bind(c);
        c.createMediaElementSource = (el) => {
            if (collide) throw new DOMException('already connected', 'InvalidStateError');
            return orig(el);
        };
        c.close = () => Promise.resolve();
        return c;
    };

    await reevaluateWithFallback(sb);            // element engage fails (collision)
    assert.ok(!sb.__calls.setRendererBus.some(([en]) => en === true), 'bus never left enabled');

    collide = false;
    await sb.window._reevaluateRendererBus();    // retry succeeds — no TypeError, fresh ctx

    assert.deepEqual(sb.__calls.setRendererBus.at(-1), [true, 1.0], 'element engaged after collision cleared');
});

test('engine stops → bus disabled', async () => {
    let running = true;
    const sb = makeSandbox({ isAudioRunning: () => running, exclusive: () => true });
    sb.window.feedBack.stems.audioGraph = makeStemsGraph();
    await sb.window._reevaluateRendererBus();

    running = false;
    await sb.window._reevaluateRendererBus();

    assert.deepEqual(sb.__calls.setRendererBus.at(-1), [false, 0], 'bus disabled after engine stop');
});
