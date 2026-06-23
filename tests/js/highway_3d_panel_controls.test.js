// Contract test for 3D Highway per-panel control metadata (feedBack#247).
// The plugin script is evaluated in a vm sandbox so factory statics are
// tested without constructing a renderer instance or calling init().

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCREEN_JS = path.join(__dirname, '..', '..', 'plugins', 'highway_3d', 'screen.js');

// 'palette' was removed — per-string colors are now set via the core
// "Highway String Colors" UI, which drives both highways by named string.
const REQUIRED_KEYS = ['cameraSmoothing', 'cameraLockLow', 'cameraLockZoom'];
const FORBIDDEN_KEYS = ['customImageDataUrl', 'customImageName', 'customVideoName'];
const VALID_TYPES = new Set(['select', 'range', 'toggle']);

function loadHighway3dStatics() {
    const src = fs.readFileSync(SCREEN_JS, 'utf8');
    // Inject test exports right after the factory registration — a stable,
    // semantic anchor inside the IIFE — so harmless footer edits (a trailing
    // sourceMappingURL comment, extra whitespace, a different IIFE close
    // style) do not break this contract test.
    const ANCHOR = 'window.feedBackViz_highway_3d = createFactory;';
    assert.equal(
        src.split(ANCHOR).length - 1,
        1,
        'expected exactly one factory-registration anchor in screen.js',
    );
    const instrumented = src.replace(
        ANCHOR,
        `${ANCHOR}\n    window.__h3dTestExports = { BG_DEFAULTS };`,
    );
    assert.notEqual(instrumented, src, 'test export injection anchor not found in screen.js');

    const sandbox = {
        console: {
            error() {},
            log() {},
            warn() {},
        },
        localStorage: {
            getItem() { return null; },
            setItem() {},
        },
        performance: { now: () => 0 },
        window: {
            feedBackTour: {
                register() {},
            },
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(instrumented, sandbox, { filename: SCREEN_JS });
    return sandbox.window;
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function optionValue(option) {
    if (option && typeof option === 'object') return option.id;
    return undefined;
}

function assertOptionObject(option, controlKey) {
    assert.equal(
        Object.prototype.toString.call(option),
        '[object Object]',
        `${controlKey}.options entries must be { id, label } objects`,
    );
    assert.equal(typeof option.id, 'string', `${controlKey}.options id must be a string`);
    assert.ok(option.id.length > 0, `${controlKey}.options id must not be blank`);
    assert.equal(typeof option.label, 'string', `${controlKey}.options label must be a string`);
    assert.ok(option.label.trim().length > 0, `${controlKey}.options label must not be blank`);
}

test('3D Highway exposes static panelControls descriptors for per-panel hosts', () => {
    const window = loadHighway3dStatics();
    const factory = window.feedBackViz_highway_3d;
    assert.equal(typeof factory, 'function', 'screen.js must register the 3D Highway factory');

    assert.ok(
        Object.prototype.hasOwnProperty.call(factory, 'panelControls'),
        'panelControls must be an own static property on the factory',
    );
    assert.ok(Array.isArray(factory.panelControls), 'panelControls must be an array');

    const controls = cloneJson(factory.panelControls);
    const defaults = cloneJson(window.__h3dTestExports.BG_DEFAULTS);
    const keys = controls.map((control) => control && control.key);
    assert.deepEqual(keys, REQUIRED_KEYS, 'panelControls must expose exactly the issue #247 control set');
    const duplicateKeys = keys.filter((key, index) => keys.indexOf(key) !== index);
    assert.deepEqual(duplicateKeys, [], 'panelControls keys must be unique');

    const controlsByKey = new Map();

    for (const control of controls) {
        assert.equal(
            Object.prototype.toString.call(control),
            '[object Object]',
            'each panel control must be a plain descriptor object',
        );
        assert.equal(typeof control.key, 'string', 'descriptor.key must be a string');
        assert.match(control.key, /^[A-Za-z][A-Za-z0-9]*$/, 'descriptor.key must be a BG_DEFAULTS-style key');
        assert.equal(typeof control.label, 'string', `${control.key}.label must be a string`);
        assert.ok(control.label.trim().length > 0, `${control.key}.label must not be blank`);
        assert.equal(typeof control.type, 'string', `${control.key}.type must be a string`);
        assert.ok(VALID_TYPES.has(control.type), `${control.key}.type must be select, range, or toggle`);
        assert.ok(Object.prototype.hasOwnProperty.call(control, 'default'), `${control.key} must declare a default`);
        assert.ok(
            Object.prototype.hasOwnProperty.call(defaults, control.key),
            `${control.key} must map to a BG_DEFAULTS entry`,
        );
        assert.deepEqual(control.default, defaults[control.key], `${control.key}.default must match BG_DEFAULTS`);
        assert.ok(!controlsByKey.has(control.key), `${control.key} appears more than once in panelControls`);
        controlsByKey.set(control.key, control);

        if (control.type === 'select') {
            assert.ok(Array.isArray(control.options), `${control.key}.options must be an array`);
            assert.ok(control.options.length > 0, `${control.key}.options must not be empty`);
            const values = control.options.map(optionValue);
            assert.equal(values.length, new Set(values).size, `${control.key}.options values must be unique`);
            for (const option of control.options) {
                assertOptionObject(option, control.key);
            }
            for (const value of values) {
                assert.equal(typeof value, 'string', `${control.key}.options values must be strings`);
            }
            assert.ok(values.includes(control.default), `${control.key}.options must include the default`);
        }

        if (control.type === 'range') {
            assert.equal(typeof control.min, 'number', `${control.key}.min must be a number`);
            assert.equal(typeof control.max, 'number', `${control.key}.max must be a number`);
            assert.ok(Number.isFinite(control.min), `${control.key}.min must be finite`);
            assert.ok(Number.isFinite(control.max), `${control.key}.max must be finite`);
            assert.ok(control.min < control.max, `${control.key}.min must be less than max`);
            assert.equal(typeof control.default, 'number', `${control.key}.default must be numeric`);
            assert.ok(control.default >= control.min, `${control.key}.default must be >= min`);
            assert.ok(control.default <= control.max, `${control.key}.default must be <= max`);
            if (Object.prototype.hasOwnProperty.call(control, 'step')) {
                assert.equal(typeof control.step, 'number', `${control.key}.step must be a number`);
                assert.ok(control.step > 0, `${control.key}.step must be positive`);
            }
        }

        if (control.type === 'toggle') {
            assert.equal(typeof control.default, 'boolean', `${control.key}.default must be boolean`);
        }
    }

    for (const key of REQUIRED_KEYS) {
        assert.ok(controlsByKey.has(key), `panelControls must include ${key}`);
    }
    for (const key of FORBIDDEN_KEYS) {
        assert.ok(!controlsByKey.has(key), `panelControls must not expose global-only asset key ${key}`);
    }

    const cameraSmoothing = controlsByKey.get('cameraSmoothing');
    assert.equal(cameraSmoothing.type, 'range', 'cameraSmoothing must be a range control');
    assert.equal(cameraSmoothing.min, 0);
    assert.equal(cameraSmoothing.max, 1);
    assert.equal(cameraSmoothing.default, defaults.cameraSmoothing);

    const cameraLockLow = controlsByKey.get('cameraLockLow');
    assert.equal(cameraLockLow.type, 'toggle', 'cameraLockLow must be a toggle control');
    assert.equal(typeof cameraLockLow.default, 'boolean', 'cameraLockLow default must be boolean');
    assert.equal(cameraLockLow.default, defaults.cameraLockLow);

    const cameraLockZoom = controlsByKey.get('cameraLockZoom');
    assert.equal(cameraLockZoom.type, 'range', 'cameraLockZoom must be a range control');
    assert.equal(cameraLockZoom.min, 0);
    assert.equal(cameraLockZoom.max, 1);
    assert.equal(cameraLockZoom.default, defaults.cameraLockZoom);
});
