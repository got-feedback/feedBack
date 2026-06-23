const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createWindow, ROOT } = require('./capabilities_test_harness');

const CAPABILITIES_JS = path.join(ROOT, 'static', 'capabilities.js');
const MIDI_INPUT_JS = path.join(ROOT, 'static', 'capabilities', 'midi-input.js');

function loadMidiInput(options = {}) {
    const window = createWindow(options);
    const context = vm.createContext(window);
    vm.runInContext(fs.readFileSync(CAPABILITIES_JS, 'utf8'), context, { filename: CAPABILITIES_JS });
    vm.runInContext(fs.readFileSync(MIDI_INPUT_JS, 'utf8'), context, { filename: MIDI_INPUT_JS });
    return window;
}

// A fake provider whose enumerate/open/close are observable by the test.
function fakeProvider(window, overrides = {}) {
    const calls = { enumerate: 0, open: [], close: [] };
    window.feedBack.midiInput.registerProvider({
        providerId: 'web-midi',
        label: 'Web MIDI',
        participantId: 'input_setup',
        enumerate: async () => { calls.enumerate += 1; return overrides.sources || [{ sourceId: 'dev1', label: 'My Keyboard' }]; },
        open: async (sourceId) => { calls.open.push(sourceId); return { addListener() {}, removeListener() {}, _id: sourceId }; },
        close: (sourceId, handle) => { calls.close.push(sourceId); },
        ...overrides.handlers,
    });
    return calls;
}

test('midi-input registers an active sensitive provider-coordinator', () => {
    const window = loadMidiInput();
    const api = window.feedBack.capabilities;
    const pipeline = api.inspect('midi-input');
    assert.ok(pipeline, 'midi-input pipeline exists');
    const owner = (pipeline.participants || []).find(p => p.pluginId === 'core.midi-input');
    assert.ok(owner, 'core.midi-input owner registered');
    assert.equal(owner.safety, 'sensitive');
    assert.equal(owner.kind, 'provider-coordinator');
    for (const cmd of ['inspect', 'list-sources', 'discover', 'select-source', 'open-source', 'close-source']) {
        assert.ok(owner.commands.includes(cmd), `owner exposes ${cmd}`);
    }
    assert.equal(window.feedBack.midiInput.version, 1);
});

test('list-sources and select-source are prompt-free (never enumerate)', async () => {
    const window = loadMidiInput();
    const api = window.feedBack.capabilities;
    const calls = fakeProvider(window);
    const listed = await api.dispatch({ capability: 'midi-input', command: 'list-sources', source: 'tester' });
    assert.equal(listed.outcome, 'handled');
    assert.equal(calls.enumerate, 0, 'list-sources must not request MIDI access');
});

test('discover is the permission boundary and surfaces sources', async () => {
    const window = loadMidiInput();
    const api = window.feedBack.capabilities;
    const calls = fakeProvider(window);
    const r = await api.dispatch({ capability: 'midi-input', command: 'discover', source: 'tester' });
    assert.equal(r.outcome, 'handled');
    assert.equal(calls.enumerate, 1, 'discover requests MIDI access exactly once');
    const sources = window.feedBack.midiInput.listSources();
    assert.equal(sources.length, 1);
    assert.equal(sources[0].logicalSourceKey, 'web-midi::dev1');
    assert.equal(sources[0].kind, 'midi');
});

test('re-discovery drops sources for devices that vanished', async () => {
    const window = loadMidiInput();
    let devices = [{ sourceId: 'dev1', label: 'A' }, { sourceId: 'dev2', label: 'B' }];
    window.feedBack.midiInput.registerProvider({
        providerId: 'web-midi', label: 'Web MIDI',
        enumerate: async () => devices,
        open: async () => ({ addListener() {}, removeListener() {} }),
        close: () => {},
    });
    await window.feedBack.midiInput.discover();
    assert.equal(window.feedBack.midiInput.listSources().length, 2);
    devices = [{ sourceId: 'dev1', label: 'A' }];   // dev2 unplugged
    await window.feedBack.midiInput.discover();
    const keys = window.feedBack.midiInput.listSources().map((s) => s.logicalSourceKey);
    assert.equal(keys.length, 1, 'vanished device is dropped from the source list');
    assert.equal(keys[0], 'web-midi::dev1');
});

test('discover with no provider reports unavailable', async () => {
    const window = loadMidiInput();
    const api = window.feedBack.capabilities;
    const r = await api.dispatch({ capability: 'midi-input', command: 'discover', source: 'tester' });
    assert.equal(r.outcome, 'unavailable');
});

test('discover surfaces denied when MIDI access is rejected', async () => {
    const window = loadMidiInput();
    const api = window.feedBack.capabilities;
    fakeProvider(window, { handlers: { enumerate: async () => { throw new Error('SecurityError: permission denied'); } } });
    const r = await api.dispatch({ capability: 'midi-input', command: 'discover', source: 'tester' });
    assert.equal(r.outcome, 'denied');
    assert.match(r.reason, /denied/i);
});

test('select-source persists by logicalSourceKey', async () => {
    const window = loadMidiInput();
    const api = window.feedBack.capabilities;
    fakeProvider(window);
    await api.dispatch({ capability: 'midi-input', command: 'discover', source: 'tester' });
    const sel = await api.dispatch({ capability: 'midi-input', command: 'select-source', source: 'tester', payload: { logicalSourceKey: 'web-midi::dev1' } });
    assert.equal(sel.outcome, 'handled');
    assert.equal(window.__storage.get('feedBack.midiInput.selectedLogicalSourceKey'), 'web-midi::dev1');
    assert.ok(window.feedBack.midiInput.listSources()[0].selected);
});

test('open/close share one session and release on the last requester', async () => {
    const window = loadMidiInput();
    const api = window.feedBack.capabilities;
    const calls = fakeProvider(window);
    await window.feedBack.midiInput.discover();
    await window.feedBack.midiInput.select('web-midi::dev1');
    const a = await api.dispatch({ capability: 'midi-input', command: 'open-source', source: 'reqA', payload: { logicalSourceKey: 'web-midi::dev1' } });
    const b = await api.dispatch({ capability: 'midi-input', command: 'open-source', source: 'reqB', payload: { logicalSourceKey: 'web-midi::dev1' } });
    assert.equal(a.outcome, 'handled');
    assert.equal(b.outcome, 'handled');
    assert.equal(calls.open.length, 1, 'provider.open called once for a shared session');
    // First release keeps the session open; second closes it.
    await api.dispatch({ capability: 'midi-input', command: 'close-source', source: 'reqA', payload: { logicalSourceKey: 'web-midi::dev1' } });
    assert.equal(calls.close.length, 0, 'session stays open while a requester holds it');
    await api.dispatch({ capability: 'midi-input', command: 'close-source', source: 'reqB', payload: { logicalSourceKey: 'web-midi::dev1' } });
    assert.equal(calls.close.length, 1, 'provider.close after the last release');
});

test('concurrent opens for one source coalesce onto a single provider.open', async () => {
    const window = loadMidiInput();
    const api = window.feedBack.capabilities;
    // A provider whose open() stays pending until we release it, so both
    // dispatches are genuinely in flight at the same time.
    let release;
    const gate = new Promise((r) => { release = r; });
    const calls = { open: 0, close: 0 };
    window.feedBack.midiInput.registerProvider({
        providerId: 'web-midi', label: 'Web MIDI',
        enumerate: async () => [{ sourceId: 'dev1', label: 'My Keyboard' }],
        open: async () => { calls.open += 1; await gate; return { addListener() {}, removeListener() {} }; },
        close: () => { calls.close += 1; },
    });
    await window.feedBack.midiInput.discover();
    await window.feedBack.midiInput.select('web-midi::dev1');
    const p1 = api.dispatch({ capability: 'midi-input', command: 'open-source', source: 'reqA', payload: { logicalSourceKey: 'web-midi::dev1' } });
    const p2 = api.dispatch({ capability: 'midi-input', command: 'open-source', source: 'reqB', payload: { logicalSourceKey: 'web-midi::dev1' } });
    release();
    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(a.outcome, 'handled');
    assert.equal(b.outcome, 'handled');
    assert.equal(calls.open, 1, 'provider.open called exactly once despite concurrent opens');
    // Both requesters joined the single shared session: it survives the first
    // release and only closes on the last, with exactly one provider.close.
    await api.dispatch({ capability: 'midi-input', command: 'close-source', source: 'reqA', payload: { logicalSourceKey: 'web-midi::dev1' } });
    assert.equal(calls.close, 0, 'shared session stays open while reqB holds it');
    await api.dispatch({ capability: 'midi-input', command: 'close-source', source: 'reqB', payload: { logicalSourceKey: 'web-midi::dev1' } });
    assert.equal(calls.close, 1, 'provider.close once after the last requester releases');
});

test('public open() surfaces the live handle (in-page only)', async () => {
    const window = loadMidiInput();
    fakeProvider(window);
    await window.feedBack.midiInput.discover();
    await window.feedBack.midiInput.select('web-midi::dev1');
    const res = await window.feedBack.midiInput.open({ requester: 'input_setup', logicalSourceKey: 'web-midi::dev1' });
    assert.equal(res.outcome, 'handled');
    assert.ok(res.handle && typeof res.handle.addListener === 'function', 'live handle exposed via public global');
});

// Load the domain with a Web-MIDI-capable navigator so the built-in provider
// self-registers (the shared harness has no navigator, so it normally skips).
function loadWithWebMidi(inputs) {
    const window = createWindow();
    window.navigator = {
        requestMIDIAccess: async () => ({
            onstatechange: null,
            inputs: new Map(inputs.map((i) => [i.id, { id: i.id, name: i.name, onmidimessage: null }])),
        }),
    };
    const context = vm.createContext(window);
    vm.runInContext(fs.readFileSync(CAPABILITIES_JS, 'utf8'), context, { filename: CAPABILITIES_JS });
    vm.runInContext(fs.readFileSync(MIDI_INPUT_JS, 'utf8'), context, { filename: MIDI_INPUT_JS });
    return window;
}

test('built-in Web-MIDI provider self-registers + discovers, filtering loopback ports', async () => {
    const window = loadWithWebMidi([
        { id: 'kb1', name: 'My Keyboard' },
        { id: 'thru', name: 'Midi Through Port-0' }, // loopback → filtered out
    ]);
    const api = window.feedBack.capabilities;
    assert.ok(api.inspect('midi-input').participants.some(p => p.pluginId === 'core.midi-input'),
        'built-in provider registered without any plugin');
    const r = await api.dispatch({ capability: 'midi-input', command: 'discover', source: 'tester' });
    assert.equal(r.outcome, 'handled');
    const sources = window.feedBack.midiInput.listSources();
    assert.equal(sources.length, 1, 'loopback/passthrough ports are filtered');
    assert.equal(sources[0].logicalSourceKey, 'web-midi::kb1');
});

test('diagnostics are redaction-safe (no device labels, no raw messages)', async () => {
    const window = loadMidiInput();
    fakeProvider(window);
    await window.feedBack.midiInput.discover();
    const contrib = window.feedBack.diagnostics.snapshotContributions()['midi-input-capability'];
    assert.ok(contrib, 'midi-input contributes diagnostics');
    assert.equal(contrib.schema, 'feedBack.midi_input.diagnostics.v1');
    const serialized = JSON.stringify(contrib);
    assert.ok(!serialized.includes('My Keyboard'), 'device labels are redacted from diagnostics');
    for (const s of contrib.sources) assert.ok(!('label' in s), 'source entries carry no label');
});
