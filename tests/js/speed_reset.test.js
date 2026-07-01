const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = path.join(__dirname, '..', '..', 'static', 'app.js');

function extractFunction(src, signature) {
    const start = src.indexOf(signature);
    if (start === -1) throw new Error(`extractFunction: '${signature}' not found in app.js`);
    let scan = start + signature.length;
    if (src[scan] === '(') {
        let parenDepth = 1;
        scan++;
        while (scan < src.length && parenDepth > 0) {
            const ch = src[scan];
            if (ch === '(') parenDepth++;
            else if (ch === ')') parenDepth--;
            scan++;
        }
    }
    const openBrace = src.indexOf('{', scan);
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    if (depth !== 0) throw new Error(`extractFunction: unbalanced braces after '${signature}'`);
    return src.slice(start, i);
}

function buildSandbox({ juceMode = false } = {}) {
    const elements = new Map();
    const makeElement = (id) => ({
        id,
        value: id === 'speed-slider' ? 135 : '',
        textContent: id === 'speed-label' ? '1.35x' : '',
        style: {},
    });
    for (const id of ['speed-slider', 'speed-label', 'quality-select', 'highway']) {
        elements.set(id, makeElement(id));
    }
    elements.set('speed-presets', {
        id: 'speed-presets',
        querySelectorAll() { return []; },
    });
    const backingCalls = [];
    const sliderInputs = [];
    const audio = {
        playbackRate: 1.35,
        pause() {},
    };
    const jucePlayer = {
        _speed: 1.35,
        setRate(rate) { this._speed = rate; },
        stop() { return Promise.resolve(); },
    };
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        audio,
        jucePlayer,
        highway: {
            stop() {},
            init() {},
            connect(url) { sandbox.__connectedUrl = url; },
            getRenderScale: () => 1,
        },
        window: {
            _juceMode: juceMode,
            _juceAudioUrl: juceMode ? '/audio/old-song.ogg' : null,
            _currentSongAudio: { url: '/audio/old-song.ogg' },
            _clearJuceRerouteMemo() {},
            feedBack: {
                isPlaying: true,
                emit() {},
            },
            feedBackDesktop: {
                audio: {
                    setBackingSpeed(rate) {
                        backingCalls.push(['setBackingSpeed', rate]);
                        return Promise.resolve();
                    },
                    setBackingPreservePitch(value) {
                        backingCalls.push(['setBackingPreservePitch', value]);
                        return Promise.resolve();
                    },
                },
            },
        },
        document: {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, makeElement(id));
                return elements.get(id);
            },
            querySelector(selector) {
                if (selector === '.screen.active') return { id: 'home' };
                return null;
            },
        },
        location: {
            protocol: 'http:',
            host: 'localhost:9999',
        },
        URLSearchParams,
        setTimeout(fn) { fn(); return 0; },
        clearTimeout() {},
        Promise,
        decodeURIComponent,
        __elements: elements,
        __backingCalls: backingCalls,
        __sliderInputs: sliderInputs,
    };
    sandbox.window.jucePlayer = jucePlayer;
    sandbox.handleSliderInput = (el) => {
        if (el) sliderInputs.push(el.id);
    };
    vm.createContext(sandbox);
    return sandbox;
}

function extractConstLine(src, name) {
    const match = src.match(new RegExp(`const ${name} = [^;]+;`));
    if (!match) throw new Error(`extractConstLine: '${name}' not found in app.js`);
    return match[0];
}

function loadPlaySong(sandbox) {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const resetHelper = src.includes('function _resetPlaybackSpeedForNewSong')
        ? extractFunction(src, 'function _resetPlaybackSpeedForNewSong')
        : '';
    const speedPresetHelpers = src.includes('function _updateSpeedPresetButtons')
        ? `
        ${extractConstLine(src, 'SPEED_PRESET_PCTS')}
        ${extractConstLine(src, 'SPEED_SNAP_THRESHOLD')}
        ${extractFunction(src, 'function _speedPresetPctFromActive')}
        ${extractFunction(src, 'function _updateSpeedPresetButtons')}
        `
        : '';
    const code = `
        var artAbortController = null;
        var isPlaying = true;
        var currentFilename = null;
        var _playerOriginScreen = null;
        var _pendingAutostart = false;
        function _clearAutoExit() {}
        function _clearAutoplayHold() {}
        function _resolvePlayerOrigin() { return 'home'; }
        function _recordPlaybackBridge() {}
        function _cancelCountIn() {}
        function _resetJuceAudioShimChain() {}
        function _resetAudioSeekState() {}
        function setPlayButtonState() {}
        function clearLoop() {}
        function _resetSectionPracticeLog() {}
        function _hideSectionPracticeBar() {}
        function showScreen() {}
        function _getArrangementNamingMode() { return 'default'; }
        function _scheduleSectionPracticeRetries() {}
        function loadSavedLoops() {}
        function _songEventPayload() { return { time: 7, audioT: 7, chartT: 7, perfNow: 7 }; }
        ${extractFunction(src, 'function setSpeed')}
        ${speedPresetHelpers}
        ${resetHelper}
        ${extractFunction(src, 'async function playSong')}
        globalThis.__playSong = playSong;
    `;
    vm.runInContext(code, sandbox);
}

test('new song load resets the HTML audio rate, not only the visible speed controls', async () => {
    const sandbox = buildSandbox();
    loadPlaySong(sandbox);

    await sandbox.__playSong('next-song.archive');

    assert.equal(sandbox.__elements.get('speed-slider').value, 100);
    assert.match(sandbox.__elements.get('speed-label').textContent, /^1\.0{1,2}x$/);
    assert.equal(sandbox.audio.playbackRate, 1);
    assert.deepEqual(sandbox.__sliderInputs, ['speed-slider']);
});

test('new song load resets the desktop backing rate when the API is available', async () => {
    const sandbox = buildSandbox({ juceMode: true });
    loadPlaySong(sandbox);

    await sandbox.__playSong('next-song.archive');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(sandbox.jucePlayer._speed, 1);
    assert.deepEqual(sandbox.__backingCalls, [
        ['setBackingSpeed', 1],
        ['setBackingPreservePitch', true],
    ]);
});
