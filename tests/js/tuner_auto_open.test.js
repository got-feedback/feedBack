'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = path.join(__dirname, '..', '..', 'static', 'app.js');
const TUNER_SCREEN_JS = path.join(__dirname, '..', '..', 'plugins', 'tuner', 'screen.js');

function loadTuningHelpers() {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const start = src.indexOf('function isBassArrangement(');
    const endMarker = 'window.feedBack.parseRawTuningOffsets = parseRawTuningOffsets;';
    const end = src.indexOf(endMarker);
    if (start === -1 || end === -1) throw new Error('tuning helper block not found in app.js');
    const sandbox = { window: { feedBack: {} }, exports: {} };
    vm.createContext(sandbox);
    vm.runInContext(
        src.slice(start, end + endMarker.length),
        sandbox
    );
    return sandbox.window.feedBack;
}

const feedBackHelpers = loadTuningHelpers();

function createTunerSandbox() {
    const enableCalls = [];
    let playerActive = true;
    let songInfo = null;

    const sandbox = {
        console,
        Promise,
        queueMicrotask,
        setTimeout(fn) { fn(); return 0; },
        clearTimeout() {},
        fetch(url) {
            if (String(url).includes('/config')) {
                return Promise.resolve({
                    json: () => Promise.resolve({
                        showFloatingButton: true,
                        visualizationMode: 'default',
                        audioInputMode: 'auto',
                        lastInstrument: 'guitar-6',
                        lastTuning: 'Standard',
                        freeTune: false,
                        disabledTunings: [],
                        customTunings: {},
                    }),
                });
            }
            return Promise.resolve({
                json: () => Promise.resolve({
                    tunings: { 'guitar-6': { Standard: [82.41, 110, 146.83, 196, 246.94, 329.63] } },
                    referencePitch: 440,
                }),
            });
        },
        localStorage: {
            getItem: () => null,
            setItem() {},
        },
        document: {
            getElementById(id) {
                if (id === 'player') {
                    return { classList: { contains: () => playerActive } };
                }
                if (id === 'v3-tuner-wrap') return null;
                return null;
            },
            querySelector() { return null; },
            createElement(tag) {
                const el = {
                    tagName: tag.toUpperCase(),
                    src: '',
                    classList: { add() {}, remove() {}, contains: () => false },
                    className: '',
                    style: {},
                    appendChild() {},
                    remove() {},
                    addEventListener() {},
                    removeEventListener() {},
                    querySelector: () => null,
                    setAttribute() {},
                    onload: null,
                    onerror: null,
                };
                if (tag === 'script') {
                    queueMicrotask(() => { if (el.onload) el.onload(); });
                }
                return el;
            },
            head: { appendChild() {} },
            body: { appendChild() {} },
            addEventListener() {},
            removeEventListener() {},
        },
        __setPlayerActive(v) { playerActive = v; },
        __setSongInfo(info) {
            songInfo = info;
            sandbox.window.feedBack.currentSong = info ? {
                filename: info.filename || 'song.sloppak',
                arrangementIndex: info.arrangement_index,
                tuning: info.tuning,
            } : null;
        },
        __enableCalls: enableCalls,
    };

    sandbox.window = sandbox;
    sandbox.window.feedBack = {
        ...feedBackHelpers,
        on() {},
        off() {},
        currentSong: null,
    };
    sandbox.window.highway = {
        getSongInfo: () => songInfo,
    };
    sandbox.window._tunerUtils = {
        preferFlats: () => false,
        offsetsToFreqs: (offsets) => offsets.map((o, i) => 80 + i * 10),
        freqToMidi: () => 40,
        midiToNote: () => 'E',
    };
    sandbox.window._tunerUI = () => ({
        addButton() {},
        initUI() {},
        renderInstrumentOptions() {},
        renderTuningOptions() {},
        renderStringNotes() {},
        updateSaveAsCustomVisibility() {},
        updateFreeTuneUI() {},
        updateFloatingButton() {},
        updatePlayerButton() {},
        updateFloatingButtonVisibility() {},
        updateInstrumentDisplay() {},
        positionPanel() {},
        updateUI() {},
    });
    sandbox.window._tunerAudio = {
        start: async () => {},
        stop() {},
        restart: async () => {},
    };
    sandbox.window._tunerViz_default = () => ({
        update() {},
        destroy() {},
    });

    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(TUNER_SCREEN_JS, 'utf8'), sandbox);

    const realEnable = sandbox.window.tuner.enable.bind(sandbox.window.tuner);
    sandbox.window.tuner.enable = async () => {
        enableCalls.push(1);
        return realEnable();
    };

    return sandbox;
}

const CUSTOM_GUITAR = {
    filename: 'amnesia.sloppak',
    arrangement: 'Lead',
    arrangement_index: 0,
    stringCount: 6,
    tuning: [-2, 0, 0, 0, -2, -2],
};

const E_STANDARD = {
    filename: 'standard.sloppak',
    arrangement: 'Lead',
    arrangement_index: 0,
    stringCount: 6,
    tuning: [0, 0, 0, 0, 0, 0],
};

const DROP_D = {
    filename: 'dropd.sloppak',
    arrangement: 'Lead',
    arrangement_index: 0,
    stringCount: 6,
    tuning: [-2, 0, 0, 0, 0, 0],
};

const BASS_EADG = {
    filename: 'bass.sloppak',
    arrangement: 'Bass',
    arrangement_index: 0,
    stringCount: 4,
    tuning: [0, 0, 0, 0],
};

async function ready(sandbox, song) {
    sandbox.__setSongInfo(song);
    await sandbox.window._tunerAutoOpen.maybeAutoOpenOnTuningChange();
}

test('tuning identity: same effective tuning returns same key', () => {
    const sandbox = createTunerSandbox();
    const key = sandbox.window._tunerAutoOpen.tuningIdentityKey(CUSTOM_GUITAR);
    assert.equal(key, sandbox.window._tunerAutoOpen.tuningIdentityKey({ ...CUSTOM_GUITAR }));
    assert.match(key, /^g:6:-2,0,0,0,-2,-2$/);
});

test('tuning identity: DADGAD custom vs E Standard differ', () => {
    const sandbox = createTunerSandbox();
    const custom = sandbox.window._tunerAutoOpen.tuningIdentityKey(CUSTOM_GUITAR);
    const standard = sandbox.window._tunerAutoOpen.tuningIdentityKey(E_STANDARD);
    assert.notEqual(custom, standard);
});

test('tuning identity: E Standard vs Drop D differ', () => {
    const sandbox = createTunerSandbox();
    const standard = sandbox.window._tunerAutoOpen.tuningIdentityKey(E_STANDARD);
    const dropD = sandbox.window._tunerAutoOpen.tuningIdentityKey(DROP_D);
    assert.notEqual(standard, dropD);
});

test('tuning identity: bass 4-string vs guitar 6-string differ', () => {
    const sandbox = createTunerSandbox();
    const bass = sandbox.window._tunerAutoOpen.tuningIdentityKey(BASS_EADG);
    const guitar = sandbox.window._tunerAutoOpen.tuningIdentityKey({
        ...BASS_EADG,
        arrangement: 'Lead',
        stringCount: 6,
        tuning: [0, 0, 0, 0, 0, 0],
    });
    assert.notEqual(bass, guitar);
    assert.match(bass, /^b:4:/);
    assert.match(guitar, /^g:6:/);
});

test('tuning identity: missing tuning returns null', () => {
    const sandbox = createTunerSandbox();
    assert.equal(sandbox.window._tunerAutoOpen.tuningIdentityKey(null), null);
    assert.equal(sandbox.window._tunerAutoOpen.tuningIdentityKey({ tuning: [] }), null);
});

test('first song load sets lastTuningKey but does not auto-open', async () => {
    const sandbox = createTunerSandbox();
    sandbox.window._tunerAutoOpen.resetState();
    await ready(sandbox, E_STANDARD);
    assert.equal(sandbox.__enableCalls.length, 0);
    assert.equal(sandbox.window._tunerAutoOpen.getState().lastTuningKey, 'g:6:0,0,0,0,0,0');
});

test('custom tuning then E Standard triggers one auto-open', async () => {
    const sandbox = createTunerSandbox();
    sandbox.window._tunerAutoOpen.resetState();
    await ready(sandbox, CUSTOM_GUITAR);
    await ready(sandbox, E_STANDARD);
    assert.equal(sandbox.__enableCalls.length, 1);
});

test('E Standard then Drop D triggers one auto-open', async () => {
    const sandbox = createTunerSandbox();
    sandbox.window._tunerAutoOpen.resetState();
    await ready(sandbox, E_STANDARD);
    await ready(sandbox, DROP_D);
    assert.equal(sandbox.__enableCalls.length, 1);
});

test('same tuning twice does not auto-open', async () => {
    const sandbox = createTunerSandbox();
    sandbox.window._tunerAutoOpen.resetState();
    await ready(sandbox, E_STANDARD);
    await ready(sandbox, { ...E_STANDARD, filename: 'other.sloppak' });
    assert.equal(sandbox.__enableCalls.length, 0);
});

test('duplicate song:ready for same tuning does not auto-open repeatedly', async () => {
    const sandbox = createTunerSandbox();
    sandbox.window._tunerAutoOpen.resetState();
    await ready(sandbox, CUSTOM_GUITAR);
    await ready(sandbox, E_STANDARD);
    await ready(sandbox, E_STANDARD);
    assert.equal(sandbox.__enableCalls.length, 1);
});

test('if tuner already enabled, no duplicate enable call', async () => {
    const sandbox = createTunerSandbox();
    sandbox.window._tunerAutoOpen.resetState();
    await ready(sandbox, CUSTOM_GUITAR);
    sandbox.window._tunerAutoOpen.setEnabledForTests(true);
    const before = sandbox.__enableCalls.length;
    await ready(sandbox, E_STANDARD);
    assert.equal(sandbox.__enableCalls.length, before);
});

test('user dismiss prevents reopen for same session', async () => {
    const sandbox = createTunerSandbox();
    sandbox.window._tunerAutoOpen.resetState();
    await ready(sandbox, CUSTOM_GUITAR);
    await ready(sandbox, { ...E_STANDARD, filename: 'amnesia.sloppak', arrangement_index: 0 });
    assert.equal(sandbox.__enableCalls.length, 1);
    sandbox.window._tunerAutoOpen.setEnabledForTests(true);
    sandbox.window.tuner.disable();
    await ready(sandbox, { ...DROP_D, filename: 'amnesia.sloppak', arrangement_index: 0 });
    assert.equal(sandbox.__enableCalls.length, 1);
});

test('song:loading clears dismiss state for next load', async () => {
    const sandbox = createTunerSandbox();
    sandbox.window._tunerAutoOpen.resetState();
    await ready(sandbox, CUSTOM_GUITAR);
    await ready(sandbox, E_STANDARD);
    sandbox.window.tuner.disable();
    sandbox.window._tunerAutoOpen.onSongLoading();
    await ready(sandbox, DROP_D);
    assert.equal(sandbox.__enableCalls.length, 2);
});

test('screen.js registers song:loading and song:ready auto-open listeners at boot', () => {
    const src = fs.readFileSync(TUNER_SCREEN_JS, 'utf8');
    assert.match(src, /function _installAutoOpenListeners/);
    assert.match(src, /window\.feedBack\.on\('song:loading', _onAutoOpenSongLoading\)/);
    assert.match(src, /window\.feedBack\.on\('song:ready', _onAutoOpenSongReady\)/);
    assert.match(src, /function _tuningIdentityKey/);
    assert.doesNotMatch(src, /restartCurrentSong/);
});

test('auto-open does not require app.js changes', () => {
    const appSrc = fs.readFileSync(APP_JS, 'utf8');
    assert.doesNotMatch(appSrc, /_tunerAutoOpen|maybeAutoOpenOnTuningChange/);
});
