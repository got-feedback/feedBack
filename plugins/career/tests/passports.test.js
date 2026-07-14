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

test('ppFillFraction: song progress toward the bar, in-progress only', () => {
    const { ppFillFraction } = load().__careerPassportTest;
    const p = (badge, q, songs) => ({ badge, qualifying_count: q, requirement: { songs } });
    assert.equal(ppFillFraction(p('in_progress', 3, 5)), 0.6);
    assert.equal(ppFillFraction(p('in_progress', 0, 5)), 0);
    assert.equal(ppFillFraction(p('in_progress', 7, 5)), 1);   // clamped
    assert.equal(ppFillFraction(p('earned', 5, 5)), 0);        // no fill once earned
    assert.equal(ppFillFraction(p('shown_not_judged', 3, 5)), 0);
    assert.equal(ppFillFraction(p('in_progress', 3, 0)), 0);   // no bar → no fill
    assert.equal(ppFillFraction(null), 0);
});

test('careerTotals / wall + dash card stay absent without commitment', () => {
    const w = load();
    const t = w.__careerPassportTest;
    // No _pp at all → null; committed-less view → null (absent-not-empty).
    assert.equal(t.careerTotals(), null);
    t.setView({ config: { instruments: ['guitar'] },
        instruments: { guitar: { committed_at: null, passports: [] } } });
    assert.equal(t.careerTotals(), null);
    // Committed but zero passports opened: still absent (no zero-wall).
    t.setView({ config: { instruments: ['guitar'] },
        instruments: { guitar: { committed_at: 'x', passports: [] } } });
    assert.equal(t.careerTotals(), null);
    // Committed with an earned badge + hours → totals aggregate.
    t.setView({ config: { instruments: ['guitar', 'bass'] },
        instruments: {
            guitar: { committed_at: 'x', passports: [
                { badge: 'earned', seconds_total: 3600, genre: 'Blues', genre_key: 'blues' },
                { badge: 'in_progress', seconds_total: 120, genre: 'Funk', genre_key: 'funk',
                  qualifying_count: 4, requirement: { songs: 5, min_stars: 2 } }] },
            bass: { committed_at: null, passports: [] },
        } });
    const totals = t.careerTotals();
    assert.equal(totals.badges, 1);
    assert.equal(totals.seconds, 3720);
    assert.equal(totals.walls.length, 1);
});

test('gig runner lifecycle: advance on ended, abandon on dead-queue stop', () => {
    const w = load();
    const t = w.__careerPassportTest;
    let remaining = 1;
    w.feedBack = { playQueue: { remaining: () => remaining, active: () => remaining > 0 } };
    t.setGigRun({
        songs: [{ filename: 'a', title: 'A' }, { filename: 'b', title: 'B' }],
        venue_id: null, genre: 'Soul', genre_key: 'soul', instrument: 'guitar', idx: 0,
    });
    // First song ends, one remains → the strip advances, no completion.
    t.onGigSongEnded();
    assert.equal(t.getGigRun().idx, 1);
    // Stop while the queue is still active (end-of-song teardown) → run survives.
    t.onGigSongStop();
    assert.notEqual(t.getGigRun(), null);
    // User quits: queue cleared → stop with a dead queue abandons (no log).
    remaining = 0;
    t.onGigSongStop();
    assert.equal(t.getGigRun(), null);
});

test('a gold upgrade notifies even when the bronze moment was already seen', () => {
    // Bronze seen under the legacy un-suffixed id; the badge then turns gold.
    const w = load({ 'feedBack-career-badges-seen': '{"guitar/blues":1}' });
    const t = w.__careerPassportTest;
    const view = { instruments: { guitar: { passports: [
        { genre_key: 'blues', genre: 'Blues', badge: 'gold' }] } } };
    t.detectNewBadges(view);
    assert.equal(w.notifications.length, 1);
    assert.match(w.notifications[0].title, /Gold/);
    // Same session: no duplicate.
    t.detectNewBadges(view);
    assert.equal(w.notifications.length, 1);
    // Gold slam seen → fresh session stays silent.
    t.markBadgeSeen('guitar', 'blues', 'gold');
    const w2 = load({ 'feedBack-career-badges-seen': JSON.stringify(t.seenBadges()) });
    w2.__careerPassportTest.detectNewBadges(view);
    assert.equal(w2.notifications.length, 0);
});

test('a gold slam marks the bronze moment seen too — never both ceremonies', () => {
    const w = load();
    const t = w.__careerPassportTest;
    t.markBadgeSeen('guitar', 'blues', 'gold');
    const seen = JSON.parse(JSON.stringify(t.seenBadges()));
    assert.equal(seen['guitar/blues@gold'], 1);
    assert.equal(seen['guitar/blues'], 1);
    // A later view where the badge reads 'earned' (e.g. gold state lost
    // server-side) must not replay the bronze ceremony.
    const view = { instruments: { guitar: { passports: [
        { genre_key: 'blues', genre: 'Blues', badge: 'earned' }] } } };
    const w2 = load({ 'feedBack-career-badges-seen': JSON.stringify(seen) });
    w2.__careerPassportTest.detectNewBadges(view);
    assert.equal(w2.notifications.length, 0);
});

test('careerTotals counts gold badges on the wall', () => {
    const t = load().__careerPassportTest;
    t.setView({
        config: { instruments: ['guitar'] },
        instruments: { guitar: { committed_at: 1, gig_count: 0, passports: [
            { genre_key: 'blues', genre: 'Blues', badge: 'gold', seconds_total: 60 },
            { genre_key: 'funk', genre: 'Funk', badge: 'in_progress', seconds_total: 0 },
        ] } },
    });
    const totals = t.careerTotals();
    assert.equal(totals.badges, 1);
    assert.equal(totals.walls[0].earned[0].badge, 'gold');
});
