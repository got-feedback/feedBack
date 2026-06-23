// Behavioral tests for the JUCE engine-reroute watcher in static/app.js.
//
// The watcher (an IIFE, `_installJuceEngineRoutingWatcher`) migrates a loaded
// song between the HTML5 <audio> element and the native JUCE backing transport
// whenever the audio engine is started/stopped after song-load. These tests
// extract that IIFE from source and exercise `window._reevaluateJuceRouting`
// against fakes, covering: the happy-path HTML5->JUCE and JUCE->HTML5 switches,
// the JUCE hard-reject memoisation, transient-failure retry, and the
// stale-song-snapshot abort.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = path.join(__dirname, '..', '..', 'static', 'app.js');

// Brace-balanced extraction of the watcher IIFE, starting at its `(function`
// and ending after the matching `})();`.
function extractWatcherIIFE(src) {
    const marker = '(function _installJuceEngineRoutingWatcher() {';
    const start = src.indexOf(marker);
    assert.ok(start !== -1, 'watcher IIFE not found in app.js');
    const openBrace = src.indexOf('{', start);
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    assert.ok(depth === 0, 'unbalanced braces in watcher IIFE');
    // Include the trailing `)();` invocation.
    const tail = src.slice(i, i + 5);
    assert.match(tail, /^\)\(\)/, 'watcher IIFE not immediately invoked');
    return src.slice(start, i) + ')();';
}

// Build a sandbox with fakes and run the watcher IIFE inside it. Returns the
// sandbox so tests can drive window._reevaluateJuceRouting and inspect state.
function makeSandbox({ isAudioRunning, loadBackingTrack }) {
    const calls = { loadBackingTrack: [], jucePlay: 0, jucePause: 0, audioPlay: 0 };

    const audio = {
        currentTime: 12.5,
        src: 'blob:original',
        dataset: {},
        readyState: 2,
        pause() {},
        play() { calls.audioPlay++; return Promise.resolve(); },
        load() {},
        addEventListener() {},
        removeEventListener() {},
    };

    const jucePlayer = {
        _dur: 0, _pos: 0, _pollAt: 0,
        currentTime: 30,
        play() { calls.jucePlay++; return Promise.resolve(true); },
        pause() { calls.jucePause++; return Promise.resolve(); },
    };

    const juceApi = {
        isAudioRunning: () => Promise.resolve(isAudioRunning()),
        loadBackingTrack: (p) => { calls.loadBackingTrack.push(p); return Promise.resolve(loadBackingTrack()); },
        getBackingDuration: () => Promise.resolve(180),
        seekBacking: () => Promise.resolve(),
        startBacking: () => Promise.resolve(),
        stopBacking: () => Promise.resolve(),
    };

    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        performance: { now: () => 1000 },
        setInterval: () => 0,            // disable the live poll; tests call directly
        setTimeout: (fn) => { fn(); return 0; },
        clearInterval: () => {},
        clearTimeout: () => {},
        fetch: () => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ path: '/local/song.ogg' }),
        }),
        document: { hidden: false },
        isPlaying: true,
        audio,
        jucePlayer,
        __calls: calls,
    };
    sandbox.window = sandbox;
    sandbox.window.jucePlayer = jucePlayer;
    sandbox.window.feedBackDesktop = { audio: juceApi };
    sandbox.window.feedBack = { audio: {} };

    const src = fs.readFileSync(APP_JS, 'utf8');
    const iife = extractWatcherIIFE(src);
    vm.createContext(sandbox);
    vm.runInContext(iife, sandbox);
    return sandbox;
}

test('watcher IIFE exposes _reevaluateJuceRouting', () => {
    const sb = makeSandbox({ isAudioRunning: () => false, loadBackingTrack: () => true });
    assert.equal(typeof sb.window._reevaluateJuceRouting, 'function');
});

test('engine running while on HTML5 → migrates the song to JUCE', async () => {
    const sb = makeSandbox({ isAudioRunning: () => true, loadBackingTrack: () => true });
    sb.window._juceMode = false;
    sb.window._currentSongAudio = { url: '/audio/song.ogg', juceEligible: true };

    await sb.window._reevaluateJuceRouting();

    assert.equal(sb.window._juceMode, true, 'should have switched into JUCE mode');
    assert.equal(sb.window._juceAudioUrl, '/audio/song.ogg');
    assert.equal(sb.__calls.loadBackingTrack.length, 1, 'loadBackingTrack called once');
    assert.equal(sb.__calls.jucePlay, 1, 'jucePlayer.play called (song was playing)');
});

test('engine stopped while on JUCE → migrates the song back to HTML5', async () => {
    const sb = makeSandbox({ isAudioRunning: () => false, loadBackingTrack: () => true });
    sb.window._juceMode = true;
    sb.window._juceAudioUrl = '/audio/song.ogg';
    sb.window._currentSongAudio = { url: '/audio/song.ogg', juceEligible: true };

    await sb.window._reevaluateJuceRouting();

    assert.equal(sb.window._juceMode, false, 'should have switched out of JUCE mode');
    assert.equal(sb.window._juceAudioUrl, null);
    assert.equal(sb.audio.src, '/audio/song.ogg', 'HTML5 element re-pointed at the song');
});

test('routing already consistent → no-op', async () => {
    const sb = makeSandbox({ isAudioRunning: () => false, loadBackingTrack: () => true });
    sb.window._juceMode = false;                       // engine off, already HTML5
    sb.window._currentSongAudio = { url: '/audio/song.ogg', juceEligible: true };

    await sb.window._reevaluateJuceRouting();

    assert.equal(sb.__calls.loadBackingTrack.length, 0, 'no switch attempted');
});

test('non-JUCE-eligible song (sloppak stems) is never rerouted', async () => {
    const sb = makeSandbox({ isAudioRunning: () => true, loadBackingTrack: () => true });
    sb.window._juceMode = false;
    sb.window._currentSongAudio = { url: '/api/sloppak/stem.ogg', juceEligible: false };

    await sb.window._reevaluateJuceRouting();

    assert.equal(sb.window._juceMode, false, 'stems stay on HTML5');
    assert.equal(sb.__calls.loadBackingTrack.length, 0);
});

test('JUCE hard-reject is memoised → not retried on the next poll', async () => {
    const sb = makeSandbox({ isAudioRunning: () => true, loadBackingTrack: () => false });
    sb.window._juceMode = false;
    sb.window._currentSongAudio = { url: '/audio/song.ogg', juceEligible: true };

    await sb.window._reevaluateJuceRouting();
    assert.equal(sb.window._juceMode, false, 'stayed on HTML5 after reject');
    assert.equal(sb.__calls.loadBackingTrack.length, 1);

    // Second poll with the same song must NOT call loadBackingTrack again.
    await sb.window._reevaluateJuceRouting();
    assert.equal(sb.__calls.loadBackingTrack.length, 1, 'rejected URL not retried');
});

test('transient failure is NOT memoised → retried on the next poll', async () => {
    const sb = makeSandbox({ isAudioRunning: () => true, loadBackingTrack: () => true });
    // First attempt: fetch rejects (transient). Then make fetch succeed.
    let firstCall = true;
    sb.fetch = () => {
        if (firstCall) { firstCall = false; return Promise.reject(new Error('network blip')); }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ path: '/local/song.ogg' }) });
    };
    sb.window._juceMode = false;
    sb.window._currentSongAudio = { url: '/audio/song.ogg', juceEligible: true };

    await sb.window._reevaluateJuceRouting();
    assert.equal(sb.window._juceMode, false, 'transient failure left song on HTML5');

    // Next poll: transient cause cleared → switch should now succeed.
    await sb.window._reevaluateJuceRouting();
    assert.equal(sb.window._juceMode, true, 'transient failure was retried and succeeded');
});

test('jucePlayer.play() failure is transient → NOT memoised, retried next poll', async () => {
    const sb = makeSandbox({ isAudioRunning: () => true, loadBackingTrack: () => true });
    // First switch: JUCE transport start fails (play returns false). Second: succeeds.
    let firstPlay = true;
    sb.jucePlayer.play = () => {
        sb.__calls.jucePlay++;
        if (firstPlay) { firstPlay = false; return Promise.resolve(false); }
        return Promise.resolve(true);
    };
    sb.window._juceMode = false;
    sb.window._currentSongAudio = { url: '/audio/song.ogg', juceEligible: true };

    await sb.window._reevaluateJuceRouting();
    assert.equal(sb.window._juceMode, false, 'play() failure left song on HTML5');

    // A play() failure must NOT be memoised as a hard reject — retry succeeds.
    await sb.window._reevaluateJuceRouting();
    assert.equal(sb.window._juceMode, true, 'transport-start failure was retried and succeeded');
});

test('stale-abort during a swap-then-restore is NOT memoised as a JUCE reject', async () => {
    // _currentSongAudio is swapped to a different object and then back to the
    // *same URL* (a new object) mid-flight. The post-await staleness check
    // would pass, but the switch already aborted as 'stale' — and a 'stale'
    // abort must never poison _rerouteRejectedUrl. A later poll must still
    // be able to route the track.
    const sb = makeSandbox({ isAudioRunning: () => true, loadBackingTrack: () => true });
    const snapA = { url: '/audio/song.ogg', juceEligible: true };
    sb.window._juceMode = false;
    sb.window._currentSongAudio = snapA;

    let firstLoad = true;
    sb.window.feedBackDesktop.audio.loadBackingTrack = (p) => {
        sb.__calls.loadBackingTrack.push(p);
        if (firstLoad) {
            firstLoad = false;
            // Swap away (makes the in-flight switch stale), then restore a NEW
            // object with the same URL before _reevaluateJuceRouting's later check.
            sb.window._currentSongAudio = { url: '/audio/other.ogg', juceEligible: true };
            sb.window._currentSongAudio = { url: '/audio/song.ogg', juceEligible: true };
        }
        return Promise.resolve(true);
    };

    await sb.window._reevaluateJuceRouting();   // aborts 'stale' — must not memoise

    // A fresh poll against the current song must still attempt the switch.
    await sb.window._reevaluateJuceRouting();
    assert.equal(sb.window._juceMode, true, 'track was not poisoned by the stale abort');
});

test('deferred JUCE→HTML5 loadedmetadata callback is a no-op once the song changed', async () => {
    const sb = makeSandbox({ isAudioRunning: () => false, loadBackingTrack: () => true });
    // Element not ready: the resume runs from a loadedmetadata listener.
    sb.audio.readyState = 0;
    let metadataCb = null;
    sb.audio.addEventListener = (ev, cb) => { if (ev === 'loadedmetadata') metadataCb = cb; };
    let seekedTo = null;
    Object.defineProperty(sb.audio, 'currentTime', {
        get() { return 0; },
        set(v) { seekedTo = v; },
        configurable: true,
    });

    sb.window._juceMode = true;
    sb.window._juceAudioUrl = '/audio/song-a.ogg';
    const snapshot = { url: '/audio/song-a.ogg', juceEligible: true };
    sb.window._currentSongAudio = snapshot;

    await sb.window._reevaluateJuceRouting();      // switches to HTML5, arms listener
    assert.ok(typeof metadataCb === 'function', 'loadedmetadata listener was registered');

    // Song changes before metadata arrives, then the stale callback fires.
    sb.window._currentSongAudio = { url: '/audio/song-b.ogg', juceEligible: true };
    metadataCb();

    assert.equal(seekedTo, null, 'stale callback must not seek the newly loaded song');
});

test('reroute sets window._juceRerouteInProgress during the switch and clears it after', async () => {
    // The <audio> play/pause listeners (outside this IIFE) suppress their
    // song:play / song:pause emissions while this flag is truthy, keeping a
    // transparent migration from desyncing plugin play-state. Verify the
    // watcher raises the flag during the switch and releases it afterwards.
    const sb = makeSandbox({ isAudioRunning: () => true, loadBackingTrack: () => true });
    let flagSeenDuringPause = false;
    sb.audio.pause = () => { flagSeenDuringPause = !!sb.window._juceRerouteInProgress; };
    sb.window._juceMode = false;
    sb.window._currentSongAudio = { url: '/audio/song.ogg', juceEligible: true };

    await sb.window._reevaluateJuceRouting();

    assert.equal(flagSeenDuringPause, true, 'flag must be set when audio.pause() runs');
    // setTimeout is patched to run synchronously, so the deferred release has
    // already happened by here.
    assert.equal(sb.window._juceRerouteInProgress, 0, 'flag refcount released after the switch');
});

test('JUCE→HTML5 reroute releases the suppression refcount even if metadata never arrives', async () => {
    // If the new HTML5 source never reaches loadedmetadata (bad URL / network
    // error), the suppression refcount must still be released — otherwise
    // song:play / song:pause stay silenced forever. The backstop timeout (and
    // 'error' listener) guarantee release. setTimeout is patched to run
    // synchronously here, so the backstop fires immediately.
    const sb = makeSandbox({ isAudioRunning: () => false, loadBackingTrack: () => true });
    sb.audio.readyState = 0;                 // metadata not ready → deferred path
    sb.audio.addEventListener = () => {};    // loadedmetadata/error never fire
    sb.window._juceMode = true;
    sb.window._juceAudioUrl = '/audio/song.ogg';
    sb.window._currentSongAudio = { url: '/audio/song.ogg', juceEligible: true };

    await sb.window._reevaluateJuceRouting();

    assert.equal(sb.window._juceRerouteInProgress, 0,
        'suppression refcount must not leak when metadata never arrives');
});

test('_rerouteInFlight guard blocks an overlapping invocation past the first await', async () => {
    // The flag must be claimed synchronously before isAudioRunning() so a
    // second poll tick during a slow IPC cannot run a concurrent switch.
    let resolveRunning;
    const sb = makeSandbox({
        isAudioRunning: () => new Promise((r) => { resolveRunning = r; }),
        loadBackingTrack: () => true,
    });
    sb.window._juceMode = false;
    sb.window._currentSongAudio = { url: '/audio/song.ogg', juceEligible: true };

    // First call: parks on the pending isAudioRunning() promise.
    const first = sb.window._reevaluateJuceRouting();
    // Second call while the first is still awaiting — must early-return.
    await sb.window._reevaluateJuceRouting();
    assert.equal(sb.__calls.loadBackingTrack.length, 0,
        'overlapping invocation must not start a switch while one is in flight');

    // Let the first finish.
    resolveRunning(true);
    await first;
    assert.equal(sb.__calls.loadBackingTrack.length, 1, 'the first switch ran exactly once');
});

test('_clearJuceRerouteMemo lets a rejected URL be retried after song teardown', async () => {
    const sb = makeSandbox({ isAudioRunning: () => true, loadBackingTrack: () => false });
    sb.window._juceMode = false;
    sb.window._currentSongAudio = { url: '/audio/song.ogg', juceEligible: true };

    await sb.window._reevaluateJuceRouting();   // hard reject → URL memoised
    assert.equal(sb.__calls.loadBackingTrack.length, 1);

    // Without a clear, the same URL is skipped.
    await sb.window._reevaluateJuceRouting();
    assert.equal(sb.__calls.loadBackingTrack.length, 1, 'memoised URL skipped');

    // Song teardown clears the memo; a fresh load of the same URL retries.
    assert.equal(typeof sb.window._clearJuceRerouteMemo, 'function');
    sb.window._clearJuceRerouteMemo();
    sb.window._currentSongAudio = { url: '/audio/song.ogg', juceEligible: true };
    await sb.window._reevaluateJuceRouting();
    assert.equal(sb.__calls.loadBackingTrack.length, 2, 'cleared memo allows a fresh attempt');
});

test('song change mid-flight aborts the switch without mutating routing', async () => {
    const sb = makeSandbox({ isAudioRunning: () => true, loadBackingTrack: () => true });
    sb.window._juceMode = false;
    const original = { url: '/audio/song-a.ogg', juceEligible: true };
    sb.window._currentSongAudio = original;
    // Swap the current song the moment loadBackingTrack is consulted, so the
    // post-await staleness check sees a different _currentSongAudio identity.
    sb.window.feedBackDesktop.audio.loadBackingTrack = () => {
        sb.window._currentSongAudio = { url: '/audio/song-b.ogg', juceEligible: true };
        return Promise.resolve(true);
    };

    await sb.window._reevaluateJuceRouting();

    assert.equal(sb.window._juceMode, false, 'stale switch must not commit JUCE mode');
    assert.notEqual(sb.window._juceAudioUrl, '/audio/song-a.ogg', 'stale URL not committed');
});
