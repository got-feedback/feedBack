/*
 * fee[dB]ack — global mirroring for panes.
 *
 * The camera-director problem, solved without touching a single renderer.
 *
 * The 3D highways read their free-camera state from a plain global —
 * `window.__h3dCamCtl = { enabled, heightMul, distMul, yaw, pitch, panX, panY }`
 * (plugins/highway_3d/FREECAM_BRIDGE.md) — once per frame, in _resolveFreeCam().
 * A camera panel in the main window just writes that object and the camera moves.
 *
 * A panel in a POP-OUT window cannot: `window.__h3dCamCtl` there is a different
 * object in a different realm, and writing it moves nothing.
 *
 * So a pane declares one manifest field:
 *
 *     panes.register({ id: 'camera_director', mirrorGlobal: '__h3dCamCtl', ... })
 *
 * and this file — which runs in the MAIN realm, where the renderers live — copies
 * that pane's state onto the global whenever it changes. The pane writes
 * ctx.state, the state store is authoritative here, and the renderers keep reading
 * the plain global they always read. highway_3d, keys_highway_3d and
 * drum_highway_3d are not modified, and do not know panes exist.
 *
 * The one rule that makes it work: MUTATE THE OBJECT, NEVER REPLACE IT. A renderer
 * may be holding the reference (_resolveFreeCam caches it), and swapping in a new
 * object would leave it writing to — and reading from — an orphan.
 */
(function () {
    'use strict';

    const panes = window.feedBack && window.feedBack.panes;
    const bus = window.feedBack;
    if (!panes || !bus) return;

    // paneId -> unsubscribe
    const mirrors = new Map();

    function _target(name) {
        // Create the global if the plugin that owns it hasn't yet (a pane can be
        // restored at boot before its renderer ever runs). Reuse it if it exists —
        // see the rule above.
        if (!window[name] || typeof window[name] !== 'object') window[name] = {};
        return window[name];
    }

    function _apply(name, state) {
        const target = _target(name);
        // Copy the pane's whole state root onto the global. Keys the pane doesn't
        // set are left alone rather than deleted — the global may carry fields the
        // pane knows nothing about (a renderer's own bookkeeping), and clearing
        // them would be a silent, spooky breakage.
        Object.keys(state).forEach((k) => { target[k] = state[k]; });
    }

    bus.on('panes:opened', (e) => {
        const id = e.detail && e.detail.id;
        const spec = panes.get(id);
        if (!spec || !spec.mirrorGlobal || mirrors.has(id)) return;
        const entry = panes._entry(id);
        if (!entry) return;

        // Sync once on open: a pane's persisted state is the user's last camera,
        // and it should take effect the moment the pane exists — not on their next
        // nudge of a slider.
        _apply(spec.mirrorGlobal, entry.state.all());

        mirrors.set(id, entry.state.subscribe((all) => _apply(spec.mirrorGlobal, all)));
    });

    bus.on('panes:closed', (e) => {
        const id = e.detail && e.detail.id;
        const unsub = mirrors.get(id);
        if (!unsub) return;
        unsub();
        mirrors.delete(id);
        // The global is deliberately LEFT AS IT IS. Closing the camera panel should
        // not snap the camera back to a default — that is exactly what happens
        // today (nobody clears __h3dCamCtl), and it is the behaviour users expect.
    });
})();
