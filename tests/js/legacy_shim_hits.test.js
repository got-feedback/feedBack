const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadAudioSession } = require('./audio_session_test_harness');

test('active audio domains expose expected legacy shim metadata', () => {
    const window = loadAudioSession();
    const shims = window.feedBack.capabilities.snapshotDiagnostics().compatibilityShims;
    for (const shimId of ['audio-mix.fader-registry', 'audio-mix.song-volume', 'audio-mix.analyser', 'audio-input.legacy-source', 'audio-monitoring.audio-barrier', 'stems.master-volume', 'stems.private-state']) {
        assert.equal(shims.some(shim => shim.shimId === shimId && shim.status === 'active'), true, shimId);
    }
});

test('legacy bridge hit counts are attributed to canonical audio domains', () => {
    const window = loadAudioSession();
    const audioSession = window.feedBack.audioSession;
    audioSession.recordBridgeHit({ domain: 'audio-mix', bridgeId: 'audio-mix.analyser', legacySurface: 'HTMLAudioElement analyser tap', participantId: 'highway_3d' });
    audioSession.recordBridgeHit({ domain: 'audio-input', bridgeId: 'audio-input.legacy-source', legacySurface: 'navigator.mediaDevices.getUserMedia', participantId: 'note_detect' });
    audioSession.recordBridgeHit({ domain: 'audio-monitoring', bridgeId: 'audio-monitoring.audio-barrier', legacySurface: 'window.feedBackAudioBarrier', participantId: 'note_detect' });

    const shims = window.feedBack.capabilities.snapshotDiagnostics().compatibilityShims;
    assert.equal(shims.find(shim => shim.shimId === 'audio-mix.analyser').hitCount, 1);
    assert.equal(shims.find(shim => shim.shimId === 'audio-input.legacy-source').capability, 'audio-input');
    assert.equal(shims.find(shim => shim.shimId === 'audio-monitoring.audio-barrier').hitCount, 1);
});

test('native audio-mix participant suppresses matching legacy fader and records overshadowed bridge hit', async () => {
    const { runBrowserScript, installMixerDom } = require('./audio_session_test_harness');
    const window = loadAudioSession();
    installMixerDom(window);
    runBrowserScript(window, 'static/audio-mixer.js');
    window.feedBack.audioSession.startSession({ sessionId: 'main:test-song' });

    window.feedBack.audio.registerFader({
        id: 'delay.wet',
        label: 'Delay Wet Legacy',
        min: 0,
        max: 1,
        step: 0.1,
        defaultValue: 0.2,
        logicalFaderKey: 'delay:wet',
        getValue: () => 0.2,
        setValue: () => {},
    });
    window.feedBack.audioSession.registerMixParticipant({
        participantId: 'plugin.delay.native',
        ownerPluginId: 'delay',
        label: 'Delay Wet',
        kind: 'plugin',
        sourceMode: 'native',
        logicalFaderKey: 'delay:wet',
        fader: { id: 'wet', label: 'Delay Wet', min: 0, max: 1, step: 0.1, defaultValue: 0.4, currentValue: 0.4 },
        operations: ['fader.get-value', 'fader.set-value'],
    });

    const listed = await window.feedBack.capabilities.dispatch({ capability: 'audio-mix', command: 'list-faders', source: 'test' });
    const snapshot = window.feedBack.audioSession.snapshot();
    const legacy = snapshot.domains['audio-mix'].participants.find(participant => participant.participantId === 'fader.delay.wet');

    assert.equal(listed.payload.faders.some(fader => fader.participantId === 'plugin.delay.native'), true);
    assert.equal(listed.payload.faders.some(fader => fader.participantId === 'fader.delay.wet'), false);
    assert.equal(legacy.supersededBy, 'plugin.delay.native');
    assert.equal(snapshot.domains['audio-mix'].bridges.some(bridge => bridge.status === 'overshadowed' && bridge.participantId === 'fader.delay.wet'), true);
});

// Source-level guards for PR1 runtime compatibility-shim hit accounting.
// Broader app/player/audio domains are reserved for follow-up PRs, so this
// file checks plugin attribution helpers and that library now uses the native
// capability module instead of legacy shim accounting.

const ROOT = path.join(__dirname, '..', '..');
const APP_JS = path.join(ROOT, 'static', 'app.js');
// The plugin loader was carved out of app.js into its own module (R3a); the
// library-provider code below still lives in app.js.
const PLUGIN_LOADER_JS = path.join(ROOT, 'static', 'js', 'plugin-loader.js');
// The viz layer was carved out of app.js too (R3a).
const VIZ_JS = path.join(ROOT, 'static', 'js', 'viz.js');
const LIBRARY_JS = path.join(ROOT, 'static', 'capabilities', 'library.js');
// The library itself was carved out of app.js into ./static/js/library.js (R3a). Note the
// two are DIFFERENT files: LIBRARY_JS above is the capability; this is the UI module.
// syncLibrarySong deliberately stayed behind in app.js — it reaches showScreen/playSong,
// and moving it would have dragged the whole playback core into the library module.
const LIBRARY_MODULE_JS = path.join(ROOT, 'static', 'js', 'library.js');

function source(file) {
    // Normalize CRLF: region() slices fixed CHARACTER windows, so on a
    // Windows checkout (autocrlf) every line costs one extra char and the
    // assertion target can fall outside the window.
    return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function region(src, needle, length = 1200) {
    const start = src.indexOf(needle);
    assert.ok(start !== -1, `missing source needle: ${needle}`);
    return src.slice(start, start + length);
}

test('plugin script hydration exposes the current plugin id for legacy registrations', () => {
    const src = source(PLUGIN_LOADER_JS);
    // Anchored on the ASSIGNMENT, not the URL literal: the URL is built in
    // _pluginScriptUrl() now (#879 — a rollback needs a fresh module URL for the whole
    // import graph), so the old literal no longer appears at the injection site.
    const block = region(src, 'script.src = _pluginScriptUrl(');
    assert.match(block, /window\.feedBack\._loadingPluginId\s*=\s*plugin\.id/);
    assert.match(block, /delete\s+window\.feedBack\._loadingPluginId/);
});

test('library providers route through native library capability', () => {
    const src = source(APP_JS);
    const libModule = source(LIBRARY_MODULE_JS);
    const librarySrc = source(LIBRARY_JS);
    const loader = region(libModule, 'async function loadLibraryProviders', 1800);
    const selector = region(libModule, 'async function setLibraryProvider(providerId, options = {})', 1600);
    const sync = region(src, 'async function syncLibrarySong(providerId, songId', 1600);

    assert.match(librarySrc, /capabilities\.registerOwner\(['"]library['"]/);
    assert.match(librarySrc, /kind:\s*['"]provider-coordinator['"]/);
    assert.match(librarySrc, /'library\.read': \['query-page', 'query-artists', 'query-stats', 'tuning-names'\]/);
    assert.match(librarySrc, /window\.feedBack\.libraryProviders\s*=\s*providerApi/);
    assert.match(loader, /api\.refresh\(\{ restoreSaved \}\)/);
    assert.match(selector, /capabilityApi\.command\(['"]library['"],\s*['"]select-provider['"]/);
    assert.match(sync, /capabilityApi\.command\(['"]library['"],\s*['"]sync-song['"]/);
    assert.doesNotMatch(src, /_recordLegacyLibraryProviderShim/);
    assert.doesNotMatch(src, /_recordLegacyLibraryCommand/);
    assert.doesNotMatch(librarySrc, /registerCompatibilityShim|recordLegacyHit/);
});

test('visualization renderer installs preserve plugin attribution', () => {
    const src = source(VIZ_JS);
    const tagger = region(src, 'function _tagVizRenderer(renderer, id)', 700);
    const setViz = region(src, 'function setViz(id)', 3600);
    const autoViz = region(src, 'function _autoMatchViz()', 5200);

    assert.match(tagger, /renderer\.pluginId\s*=\s*id/);
    assert.match(tagger, /renderer\.source\s*=\s*id/);
    assert.match(setViz, /_installVizRenderer\(renderer,\s*id\)|_installVizRenderer\(venueRenderer,\s*'highway_3d'\)/);
    assert.match(autoViz, /_installVizRenderer\(renderer,\s*id,\s*'auto-match'\)/);
});