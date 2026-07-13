// Passport UI pure-logic tests: load screen.js in a bare vm window and
// exercise the __careerPassportTest seam (no DOM beyond stubs, no network).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(seed) {
    const store = Object.assign({}, seed);
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

    // Fresh session (new vm, empty notify cache) with the badge already seen:
    // detection must stay silent.
    const w2 = load({ 'feedBack-career-badges-seen': '{"guitar/blues":1}' });
    w2.__careerPassportTest.detectNewBadges(view);
    assert.equal(w2.notifications.length, 0);
});

test('a new badge triggers the crowd celebrate() exactly once', () => {
    const w = load();
    let calls = 0;
    w.v3VenueCrowd = { celebrate: () => { calls += 1; } };
    const view = { instruments: { guitar: { passports: [
        { genre_key: 'blues', genre: 'Blues', badge: 'earned' }] } } };
    w.__careerPassportTest.detectNewBadges(view);
    assert.equal(calls, 1);
    // Same session, same view: no re-celebration.
    w.__careerPassportTest.detectNewBadges(view);
    assert.equal(calls, 1);
});

test('ceremony degrades when the crowd layer is absent or throws', () => {
    const w = load();
    const view = { instruments: { guitar: { passports: [
        { genre_key: 'blues', genre: 'Blues', badge: 'earned' }] } } };
    // No v3VenueCrowd at all (already exercised elsewhere, explicit here).
    w.__careerPassportTest.detectNewBadges(view);
    assert.equal(w.notifications.length, 1);
    // celebrate() throwing must not break detection.
    const w2 = load();
    w2.v3VenueCrowd = { celebrate: () => { throw new Error('no pack'); } };
    w2.__careerPassportTest.detectNewBadges(view);
    assert.equal(w2.notifications.length, 1);
});

test('seenBadges tolerates corrupt stored values', () => {
    for (const bad of ['null', '[1,2]', '"x"', '{{{']) {
        const w = load({ 'feedBack-career-badges-seen': bad });
        const t = w.__careerPassportTest;
        assert.equal(JSON.stringify(t.seenBadges()), '{}', `stored ${bad}`);
        // And detection still works on top of the recovered empty state.
        t.detectNewBadges({ instruments: { guitar: { passports: [
            { genre_key: 'blues', genre: 'Blues', badge: 'earned' }] } } });
        assert.equal(w.notifications.length, 1, `stored ${bad}`);
    }
});

test('fmtHours: silent under a minute, minutes under an hour, tenths after', () => {
    const { fmtHours } = load().__careerPassportTest;
    assert.equal(fmtHours(0), '');
    assert.equal(fmtHours(59), '');
    assert.equal(fmtHours(60), '1 min');
    assert.equal(fmtHours(1800), '30 min');
    assert.equal(fmtHours(3600), '1 h');
    assert.equal(fmtHours(51120), '14.2 h');
    assert.equal(fmtHours(null), '');
    assert.equal(fmtHours('junk'), '');
});
