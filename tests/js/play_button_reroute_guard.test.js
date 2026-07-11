// Regression: the play/pause button must not be reset to "Play" when an
// in-flight togglePlay() audio.play() is rejected *because the engine reroute
// (HTML5 -> JUCE) deliberately paused the <audio> element*. Playback continues
// on the JUCE transport, so the button must stay "Pause" (isPlaying true).
//
// Bug: first song after a fresh load on desktop — the reroute's audio.pause()
// aborts autoplay's play(); togglePlay's catch then flipped the button to Play
// while the song kept playing, so it took two clicks to actually pause.
//
// Same isolation strategy as autoplay_exit.test.js: extract togglePlay() from
// app.js by brace-matching and run it in a vm sandbox with stubbed deps.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { extractFunction } = require('./test_utils');

const APP_JS = path.join(__dirname, '..', '..', 'static', 'app.js');
const SRC = fs.readFileSync(APP_JS, 'utf8');
const TOGGLE_PLAY_SRC = extractFunction(SRC, 'async function togglePlay(');

// Drive togglePlay() from the not-playing state with an HTML5 audio.play() that
// rejects, optionally with a reroute in progress. Returns the observed button
// states and the final isPlaying flag.
async function runTogglePlayRejecting({ rerouteInProgress }) {
    const buttonStates = [];
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        // not-playing -> togglePlay takes the HTML5 play branch.
        // isPlaying / lastAudioTime moved onto the shared player-state container
        // (static/js/player-state.js) so a carved module can WRITE them — an imported
        // binding is read-only. Same values, same assertions, one indirection.
        S: { isPlaying: false, lastAudioTime: 0 },
        _audioSeekGen: 0,
        _playAttemptGen: 0,
        setPlayButtonState(v) { buttonStates.push(v); },
        audio: {
            // Reject like the browser does when a pending play() is interrupted
            // by a pause() (the reroute's deliberate audio.pause()).
            play: () => Promise.reject(new DOMException('aborted by pause', 'AbortError')),
            pause() {},
        },
        jucePlayer: { play: () => Promise.resolve(true), pause: () => Promise.resolve() },
        window: {
            _juceMode: false,
            _juceRerouteInProgress: rerouteInProgress ? 1 : 0,
            feedBack: { isPlaying: false, emit() {} },
        },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(TOGGLE_PLAY_SRC, sandbox, { filename: 'app.js#togglePlay' });
    await vm.runInContext('togglePlay()', sandbox);
    return { buttonStates, isPlaying: sandbox.S.isPlaying };
}

test('reroute-aborted play() leaves the button on Pause (isPlaying stays true)', async () => {
    const { buttonStates, isPlaying } = await runTogglePlayRejecting({ rerouteInProgress: true });
    // Optimistic flip to Pause happened; the reroute guard must prevent the
    // catch from flipping it back to Play.
    assert.deepEqual(buttonStates, [true], 'button should only have been set to Pause, never reset to Play');
    assert.equal(isPlaying, true, 'isPlaying must stay true — the JUCE transport owns playback');
});

test('a genuine play() rejection (no reroute) still resets the button to Play', async () => {
    const { buttonStates, isPlaying } = await runTogglePlayRejecting({ rerouteInProgress: false });
    assert.deepEqual(buttonStates, [true, false], 'button set to Pause then correctly reset to Play on real failure');
    assert.equal(isPlaying, false, 'isPlaying must reflect the failed start');
});
