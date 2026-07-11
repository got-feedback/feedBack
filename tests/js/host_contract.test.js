// The host-seam contract: the hooks the modules USE must be exactly the hooks
// app.js WIRES.
//
// This is the test that makes the seam safe. static/js/host.js already throws at
// runtime when an unwired hook is read — but a runtime throw only fires if the
// broken path actually executes, and the entire danger of a host seam is the paths
// that DON'T run in a smoke test. That is not hypothetical: the plugin loader's
// seam defaulted a hook to `() => {}`, and a dropped wiring line would have left
// the viz picker silently not refreshing with no test, boot check, or bot noticing.
//
// So this closes it statically. Rename a hook in app.js, drop a line from the
// configureHost({…}) call, or typo a `host.foo` in a module, and CI fails — on a
// path nobody ever ran.
//
// It is deliberately symmetric:
//   * used but not wired  -> a latent crash (host.js would throw at runtime)
//   * wired but not used  -> dead weight, and usually the fossil of a rename
// Both fail.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const APP_JS = path.join(ROOT, 'static', 'app.js');
const JS_DIR = path.join(ROOT, 'static', 'js');

// Strip comments, so prose about `host.foo` in a header block is not read as a call
// site.
//
// NOTHING ELSE. An earlier version also tried to strip import statements (to stop
// `from './host.js'` reading as a hook called `js`) and its `[\s\S]*?` spanned lines
// and silently ate 14,000 characters of the file — including, in the bite test, the
// very drift it was supposed to catch. A guard with a hole in it is worse than no
// guard, because you trust it. The `host.js` path is excluded far more cheaply,
// below, by refusing a match followed by a quote.
function scrub(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/[^\n]*$/gm, '');
}

// `host.<name>` — but not `host.js'` from the `from './host.js'` import path, which is
// the one string in these files that looks like a hook and isn't.
//
// The trailing class must forbid a WORD character as well as a quote. With only
// `(?!['"])`, `host.js'` fails on `js` (a quote follows), then BACKTRACKS to `j` —
// where the next char is `s`, not a quote — and happily reports a hook called `j`.
// Forbidding `[\w$]` too leaves it nowhere to backtrack to.
const HOOK_RE = /(?<![\w$.])host\.([A-Za-z_$][\w$]*)(?![\w$'"])/g;

/** Every `host.<name>` referenced by a carved module. */
function hooksUsed() {
    const used = new Map();   // name -> [files]
    for (const file of fs.readdirSync(JS_DIR)) {
        if (!file.endsWith('.js') || file === 'host.js') continue;
        const raw = fs.readFileSync(path.join(JS_DIR, file), 'utf8');
        if (!/from\s+'\.\/host\.js'/.test(raw)) continue;
        for (const m of scrub(raw).matchAll(HOOK_RE)) {
            if (!used.has(m[1])) used.set(m[1], []);
            used.get(m[1]).push(file);
        }
    }
    return used;
}

/** Every hook app.js passes to configureHost({ … }). */
function hooksWired() {
    const src = scrub(fs.readFileSync(APP_JS, 'utf8'));
    // NB the closing brace is INDENTED (the call sits inside the boot function), so
    // anchoring on `\n});` at column 0 runs straight past it and swallows the next
    // object literal in the file — which is how this first read 77 "hooks", most of
    // them app.js's window contract.
    const call = src.match(/configureHost\(\{([\s\S]*?)\n\s*\}\);/);
    if (!call) return null;   // no seam wired yet — fine until there is one
    const wired = new Set();
    for (const m of call[1].matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?=[,:}]|$)/gm)) {
        wired.add(m[1]);
    }
    return wired;
}

test('every host.<hook> a module uses is wired by app.js', () => {
    const used = hooksUsed();
    if (used.size === 0) return;                      // no consumers yet
    const wired = hooksWired();
    assert.ok(wired, 'modules import ./host.js but app.js never calls configureHost({ … })');

    const missing = [...used.keys()]
        .filter((h) => !wired.has(h))
        .map((h) => `${h} (used in ${used.get(h).join(', ')})`);

    assert.deepEqual(
        missing, [],
        'these hooks are read by a module but never wired by app.js — they would throw at runtime, '
        + 'on whatever path happens to reach them',
    );
});

test('every hook app.js wires is actually used by a module', () => {
    const wired = hooksWired();
    if (!wired || wired.size === 0) return;
    const used = hooksUsed();

    const unused = [...wired].filter((h) => !used.has(h));

    assert.deepEqual(
        unused, [],
        'these hooks are wired by app.js but no module reads them — dead weight, and usually '
        + 'the fossil of a rename that left the other half behind',
    );
});
