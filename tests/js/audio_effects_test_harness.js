const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createWindow, ROOT } = require('./capabilities_test_harness');

const CAPABILITIES_JS = path.join(ROOT, 'static', 'capabilities.js');
const AUDIO_EFFECTS_JS = path.join(ROOT, 'static', 'capabilities', 'audio-effects.js');

function loadAudioEffects(options = {}) {
    const window = createWindow(options);
    const context = vm.createContext(window);
    vm.runInContext(fs.readFileSync(CAPABILITIES_JS, 'utf8'), context, { filename: CAPABILITIES_JS });
    vm.runInContext(fs.readFileSync(AUDIO_EFFECTS_JS, 'utf8'), context, { filename: AUDIO_EFFECTS_JS });
    window.__vmContext = context;
    return window;
}

function diagnosticsSnapshot(window) {
    return window.feedBack.audioEffects.snapshot();
}

module.exports = { loadAudioEffects, diagnosticsSnapshot, ROOT };
