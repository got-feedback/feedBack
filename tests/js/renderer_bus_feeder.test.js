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
    };
    return ctx;
}

function makeSandbox({ isAudioRunning = () => true, exclusive = () => true } = {}) {
    const calls = { setRendererBus: [], pushRendererAudio: [] };

    const api = {
        isAudioRunning: () => Promise.resolve(isAudioRunning()),
        setRendererBus: (en, g) => { calls.setRendererBus.push([en, g]); return Promise.resolve(); },
        pushRendererAudio: (buf, rate) => { calls.pushRendererAudio.push([buf.length, rate]); },
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

test('stems graph + exclusive output → bus enabled, stems ctx null-sinked', async () => {
    const sb = makeSandbox({ exclusive: () => true });
    const graph = makeStemsGraph();
    sb.window.feedBack.stems.audioGraph = graph;

    await sb.window._reevaluateRendererBus();

    assert.deepEqual(sb.__calls.setRendererBus.at(-1), [true, 1.0], 'bus enabled');
    assert.equal(graph.context.sinkIdCalls.at(-1)?.type, 'none', 'stems ctx re-pointed at null sink');
});

test('output returns to shared → bus disabled, sink restored', async () => {
    let excl = true;
    const sb = makeSandbox({ exclusive: () => excl });
    const graph = makeStemsGraph();
    sb.window.feedBack.stems.audioGraph = graph;

    await sb.window._reevaluateRendererBus();
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

test('element song + exclusive → element captured into bus', async () => {
    const sb = makeSandbox({ exclusive: () => true });
    sb.window._currentSongAudio = { url: '/api/sloppak/x.sloppak/file/stems/full.ogg' };
    sb.window._juceMode = false;

    await sb.window._reevaluateRendererBus();

    assert.equal(sb.__createdContexts.length, 1, 'capture context created');
    assert.equal(sb.__createdContexts[0].mediaSourceEl, sb.__audioEl, 'element source captured');
    assert.deepEqual(sb.__calls.setRendererBus.at(-1), [true, 1.0], 'bus enabled');
});

test('song riding the native transport (_juceMode) → feeder stays off', async () => {
    const sb = makeSandbox({ exclusive: () => true });
    sb.window._currentSongAudio = { url: '/audio/song.ogg' };
    sb.window._juceMode = true;

    await sb.window._reevaluateRendererBus();

    assert.equal(sb.__calls.setRendererBus.length, 0, 'native transport owns the song');
    assert.equal(sb.__createdContexts.length, 0, 'no capture context created');
});

test('stems graph replaced mid-engagement → re-engages on the new graph', async () => {
    const sb = makeSandbox({ exclusive: () => true });
    const g1 = makeStemsGraph();
    sb.window.feedBack.stems.audioGraph = g1;
    await sb.window._reevaluateRendererBus();

    const g2 = makeStemsGraph();
    sb.window.feedBack.stems.audioGraph = g2;
    await sb.window._reevaluateRendererBus();

    assert.equal(g2.context.sinkIdCalls.at(-1)?.type, 'none', 'new graph null-sinked');
    assert.deepEqual(sb.__calls.setRendererBus.at(-1), [true, 1.0], 're-enabled for new graph');
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
