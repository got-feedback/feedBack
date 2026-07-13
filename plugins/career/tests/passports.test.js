// Passport UI pure-logic tests: load screen.js in a bare vm window and
// exercise the __careerPassportTest seam (no DOM beyond stubs, no network).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
    const store = {};
    const window = {
        console,
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
        },
        document: {
            readyState: 'complete',
            getElementById: () => null,
            querySelectorAll: () => [],
            addEventListener: () => {},
        },
        notifications: [],
    };
    window.window = window;
    window.globalThis = window;
    window.fbNotify = { show: (n) => window.notifications.push(n) };
    const context = vm.createContext(window);
    // `document` and `localStorage` resolve as bare names inside the IIFE.
    context.document = window.document;
    context.localStorage = window.localStorage;
    const src = fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8');
    vm.runInContext(src, context, { filename: 'career/screen.js' });
    return window;
}

test('module loads (and boots) in a bare vm window', () => {
    const w = load();
    assert.equal(typeof w.__careerPassportTest.ppKey, 'function');
});

test('ppKey normalizes case and whitespace', () => {
    const { ppKey } = load().__careerPassportTest;
    assert.equal(ppKey('  Blues  Rock '), 'blues rock');
    assert.equal(ppKey('FUNK'), 'funk');
    assert.equal(ppKey(''), '');
    assert.equal(ppKey(null), '');
});

test('ppJitter is deterministic and bounded', () => {
    const { ppJitter } = load().__careerPassportTest;
    assert.equal(ppJitter('blues', 8), ppJitter('blues', 8));
    for (const seed of ['blues', 'funk', 'jazz', 'metal']) {
        const j = ppJitter(seed, 8);
        assert.ok(j >= -8 && j <= 8, `${seed} → ${j}`);
    }
    assert.notEqual(ppJitter('blues', 8), ppJitter('funk', 8));
});

test('detectNewBadges notifies once per badge, never after it is seen', () => {
    const w = load();
    const t = w.__careerPassportTest;
    const view = {
        instruments: {
            guitar: {
                passports: [
                    { genre_key: 'blues', genre: 'Blues', badge: 'earned' },
                    { genre_key: 'funk', genre: 'Funk', badge: 'in_progress' },
                ],
            },
        },
    };
    t.detectNewBadges(view);
    assert.equal(w.notifications.length, 1);
    assert.match(w.notifications[0].message, /Blues/);
    // Same view again in the same session: no duplicate notification.
    t.detectNewBadges(view);
    assert.equal(w.notifications.length, 1);
    // Seen (slam played) → a fresh session stays quiet too.
    t.markBadgeSeen('guitar', 'blues');
    // JSON-compare: vm objects carry a foreign Object prototype.
    assert.equal(JSON.stringify(t.seenBadges()), '{"guitar/blues":1}');
});
