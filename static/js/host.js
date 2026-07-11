// The host seam — how a carved-out module calls back into app.js.
//
// WHY THIS EXISTS. What is left in app.js is not a tree, it is a cycle: seeding a
// dependency closure from count-in, from loops, from section-practice, or from the
// JUCE seek shim all return the SAME 178-function set, and setLoop() and
// practiceSection() call each other directly. So a module carved out of that
// component will always need to call back into app.js — and it cannot `import`
// app.js to do it, because app.js imports the module, and that closes a cycle the
// import-x/no-cycle gate (rightly) rejects.
//
// So app.js hands its functions DOWN, once, at boot: `configureHost({ playSong, … })`.
//
// ─── THE FAILURE MODE THIS IS BUILT TO PREVENT ───────────────────────────────
//
// The obvious way to write this is a plain object with no-op defaults. That is a
// TRAP, and we walked into it once already: the plugin loader's host seam defaulted
// `populateVizPicker` to `() => {}`, which means that if the wiring call in app.js
// is ever dropped, renamed, or drifts, the loader keeps running, the viz picker
// silently stops refreshing, and NOTHING — no test, no boot check, no bot — says a
// word. A feature just quietly stops existing.
//
// Two layers stop that here, and the second is the one that actually closes it:
//
//   1. RUNTIME — reading an unwired hook THROWS. There are no defaults and no
//      stubs. `host.playSong` either is the real function or it is a loud error.
//      An unwired hook cannot degrade into a no-op, because there is nothing for
//      it to degrade INTO.
//
//   2. STATIC — tests/js/host_contract.test.js asserts that the set of hooks the
//      modules USE is exactly the set app.js WIRES. This is the important one:
//      layer 1 only fires if the broken path actually executes, and the whole
//      danger of this seam is paths that don't run in a smoke test. The static
//      check catches a drifted or misspelled hook in CI, on a path nobody ran.
//
// Consequence for anyone adding a hook: add it to the configureHost({…}) call in
// app.js *and* use it as `host.<name>`. The contract test fails on either alone —
// deliberately. A hook wired but never used is dead weight; a hook used but never
// wired is a bug that would otherwise hide.

const _hooks = Object.create(null);
let _configured = false;

/**
 * Called ONCE by app.js at boot, before any carved module runs. Every value must
 * be a function — a hook that is accidentally `undefined` (a typo, a renamed
 * export, a dropped line) fails HERE, at startup, rather than silently much later.
 */
export function configureHost(hooks) {
    if (_configured) {
        throw new Error('[host] configureHost() called twice — it must be wired exactly once, at boot.');
    }
    const bad = Object.entries(hooks || {})
        .filter(([, v]) => typeof v !== 'function')
        .map(([k]) => k);
    if (bad.length) {
        throw new Error(
            `[host] these hooks are not functions: ${bad.join(', ')}. `
            + 'A hook is usually undefined because it was renamed or its line was dropped.',
        );
    }
    Object.assign(_hooks, hooks);
    _configured = true;
}

/**
 * The seam itself. Reading a hook that was never wired THROWS — it never returns
 * undefined and never returns a silent no-op. See the note at the top: a no-op
 * default is precisely the bug this module exists to make impossible.
 */
export const host = new Proxy(Object.create(null), {
    get(_target, name) {
        if (typeof name === 'symbol') return undefined;   // let JS probe it freely
        if (!_configured) {
            throw new Error(
                `[host] host.${name} was read before configureHost() ran. `
                + 'app.js must call configureHost() at boot, before any carved module executes.',
            );
        }
        const fn = _hooks[name];
        if (typeof fn !== 'function') {
            throw new Error(
                `[host] host.${name} is not wired. Add it to the configureHost({ … }) `
                + 'call in app.js. (tests/js/host_contract.test.js should have caught this in CI.)',
            );
        }
        return fn;
    },
    // Keep the object honest for anything that introspects it.
    has(_target, name) { return name in _hooks; },
    ownKeys() { return Object.keys(_hooks); },
    getOwnPropertyDescriptor(_target, name) {
        return name in _hooks
            ? { value: _hooks[name], enumerable: true, configurable: true, writable: false }
            : undefined;
    },
    set(_target, name) {
        throw new Error(`[host] host.${String(name)} is read-only — hooks are wired only via configureHost().`);
    },
});
