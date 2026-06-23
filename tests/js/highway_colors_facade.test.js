// The public plugin API: window.feedBack.highwayColors. The facade is a thin,
// stable wrapper over the (private) string-color manager in app.js. These tests
// extract _hwcInstallFacade and run it against a fake window/bus with stubbed
// manager functions, so the documented surface + wiring are locked in.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appJs = path.join(__dirname, '..', '..', 'static', 'app.js');

function extractBlock(src, signature) {
    const start = src.indexOf(signature);
    assert.ok(start !== -1, `signature '${signature}' not found`);
    const openBrace = src.indexOf('{', start);
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    assert.equal(depth, 0, `unbalanced braces after '${signature}'`);
    return src.slice(start, i);
}

// Build a live facade by injecting stubs into the extracted installer.
function buildFacade() {
    const src = fs.readFileSync(appJs, 'utf8');
    const body = [
        'const _hwcChangeWrappers = new WeakMap();',
        extractBlock(src, 'function _hwcInstallFacade()'),
        'return _hwcInstallFacade;',
    ].join('\n');
    const params = [
        'window', 'HWC_SLOTS', 'console',
        'getHighwayStringColors', 'getHighwayDefaultSlotColors', '_hwcMergedSlotColors',
        '_hwcSlotKeysForChart', '_hwcEffectiveIndexColors', '_hwcChartShape',
        'applyHighwayStringColors', 'encodeHighwayColorShare', 'decodeHighwayColorShare',
    ];

    const listeners = {};
    const calls = [];
    const bus = {
        on(e, f) { (listeners[e] = listeners[e] || []).push(f); },
        off(e, f) { listeners[e] = (listeners[e] || []).filter((x) => x !== f); },
        emit(e, d) { (listeners[e] || []).slice().forEach((f) => f({ detail: d })); },
        _count: (e) => (listeners[e] || []).length,
    };
    const win = { feedBack: bus, highway: { getStringColors: () => ['#aaaaaa'] } };
    const HWC_SLOTS = [
        { key: 'highE', label: 'High E', sub: '1st' }, { key: 'B', label: 'B', sub: '2nd' },
        { key: 'G', label: 'G', sub: '3rd' }, { key: 'D', label: 'D', sub: '4th' },
        { key: 'A', label: 'A', sub: '5th' }, { key: 'lowE', label: 'Low E', sub: '6th' },
        { key: 'low7', label: 'Low B', sub: '7-string' }, { key: 'low8', label: 'Low F#', sub: '8-string' },
    ];
    const stubs = {
        getHighwayStringColors: () => ({ lowE: '#111111' }),
        getHighwayDefaultSlotColors: () => ({ lowE: '#cc0000', highE: '#9900cc' }),
        _hwcMergedSlotColors: () => ({ lowE: '#111111', A: '#cca800' }),
        _hwcSlotKeysForChart: (sc, isBass) => ['keys', sc, isBass],
        _hwcEffectiveIndexColors: (map, sc, isBass) => ['eff', sc, isBass],
        _hwcChartShape: () => ({ sc: 6, isBass: false }),
        applyHighwayStringColors: (m) => { calls.push(['apply', m]); },
        encodeHighwayColorShare: (n, m) => 'SLOPHWY2.CODE',
        decodeHighwayColorShare: (c) => ({ name: 'x', colors: {} }),
    };
    const installer = new Function(...params, body)(
        win, HWC_SLOTS, console,
        stubs.getHighwayStringColors, stubs.getHighwayDefaultSlotColors, stubs._hwcMergedSlotColors,
        stubs._hwcSlotKeysForChart, stubs._hwcEffectiveIndexColors, stubs._hwcChartShape,
        stubs.applyHighwayStringColors, stubs.encodeHighwayColorShare, stubs.decodeHighwayColorShare,
    );
    installer();
    return { api: win.feedBack.highwayColors, win, bus, calls, installer, stubs };
}

test('initHighwayColors installs the facade', () => {
    const src = fs.readFileSync(appJs, 'utf8');
    const init = extractBlock(src, 'function initHighwayColors()');
    assert.match(init, /_hwcInstallFacade\(\)/, 'initHighwayColors must call _hwcInstallFacade');
});

test('facade exposes the documented surface', () => {
    const { api } = buildFacade();
    assert.equal(api.version, 1);
    for (const m of ['get', 'getDefaults', 'getResolved', 'keysForChart', 'toEffective',
        'getCurrent', 'apply', 'encodeShare', 'decodeShare', 'onChange', 'offChange']) {
        assert.equal(typeof api[m], 'function', `highwayColors.${m} must be a function`);
    }
    assert.deepEqual(api.slots.map((s) => s.key),
        ['highE', 'B', 'G', 'D', 'A', 'lowE', 'low7', 'low8'], 'slots in display order');
});

test('facade read methods delegate to the manager', () => {
    const { api } = buildFacade();
    assert.deepEqual(api.get(), { lowE: '#111111' });
    assert.deepEqual(api.getDefaults(), { lowE: '#cc0000', highE: '#9900cc' });
    assert.deepEqual(api.getResolved(), { lowE: '#111111', A: '#cca800' });
    assert.deepEqual(api.keysForChart(7, true), ['keys', 7, true]);
    assert.deepEqual(api.toEffective(7, true), ['eff', 7, true]);
    assert.deepEqual(api.toEffective(), ['eff', 6, false], 'no args → current chart shape');
    assert.deepEqual(api.getCurrent(), ['#aaaaaa'], 'live 2D applied colors');
});

test('apply / share interop delegate', () => {
    const { api, calls } = buildFacade();
    api.apply({ lowE: '#abcdef' });
    assert.deepEqual(calls[0], ['apply', { lowE: '#abcdef' }]);
    assert.match(api.encodeShare('n', {}), /^SLOPHWY2\./);
    assert.deepEqual(api.decodeShare('SLOPHWY2.CODE'), { name: 'x', colors: {} });
});

test('onChange fires with resolved map and unsubscribes cleanly', () => {
    const { api, bus } = buildFacade();
    let got = null;
    const handler = (m) => { got = m; };
    const unsub = api.onChange(handler);
    assert.equal(bus._count('highway:stringColors'), 1, 'subscribed to the change event');
    bus.emit('highway:stringColors', { lowE: '#111111' });
    assert.deepEqual(got, { lowE: '#111111', A: '#cca800' }, 'handler gets the RESOLVED map');
    got = null;
    unsub();
    assert.equal(bus._count('highway:stringColors'), 0, 'unsubscribe removed the listener');
    bus.emit('highway:stringColors', {});
    assert.equal(got, null, 'no callback after unsubscribe');
    // offChange path
    const h2 = () => {};
    api.onChange(h2);
    assert.equal(bus._count('highway:stringColors'), 1);
    api.offChange(h2);
    assert.equal(bus._count('highway:stringColors'), 0);
});

test('repeated onChange with the same handler unsubscribes independently (no leak)', () => {
    const { api, bus } = buildFacade();
    let n = 0;
    const handler = () => { n++; };
    const unsubA = api.onChange(handler);
    const unsubB = api.onChange(handler);
    assert.equal(bus._count('highway:stringColors'), 2, 'two independent subscriptions');
    // First unsubscribe removes only ITS wrapper, leaving the second live.
    unsubA();
    assert.equal(bus._count('highway:stringColors'), 1, 'first unsub removes one, not both');
    bus.emit('highway:stringColors', {});
    assert.equal(n, 1, 'surviving subscription still fires');
    unsubB();
    assert.equal(bus._count('highway:stringColors'), 0, 'second unsub removes the rest');
    // offChange removes ALL remaining subscriptions of a handler at once.
    n = 0;
    api.onChange(handler); api.onChange(handler);
    assert.equal(bus._count('highway:stringColors'), 2);
    api.offChange(handler);
    assert.equal(bus._count('highway:stringColors'), 0, 'offChange clears all of fn');
});

test('install is idempotent (does not replace an existing facade)', () => {
    const { api, win, installer } = buildFacade();
    installer();
    assert.equal(win.feedBack.highwayColors, api, 'second install must be a no-op');
});
