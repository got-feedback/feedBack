/*
 * fee[dB]ack — manifest-declared plugin panes.
 *
 * A plugin can ship a pane by declaring it in plugin.json, with no code in
 * screen.js at all:
 *
 *     "panes": [{
 *         "id": "camera_director",
 *         "title": "Camera Director",
 *         "icon": "🎥",
 *         "script": "panes/camera.js",
 *         "mirrorGlobal": "__h3dCamCtl"
 *     }]
 *
 * The point of declaring it rather than calling panes.register() is that the
 * pane becomes openable — from the rail, from the tray — WITHOUT THE PLUGIN'S
 * SCREEN EVER HAVING BEEN VISITED. We register a stub from the manifest and
 * fetch the script only when the user actually opens it. A pane you can only
 * reach by first navigating to the screen it was supposed to replace is not
 * much of a pane.
 *
 * The script sets a factory global, the same shape the viz contract already uses
 * (`window.feedBackViz_<id>`):
 *
 *     window.feedBackPane_camera_director = {
 *         mount(root, ctx) { ... },
 *         unmount(root, ctx) { ... },
 *     };
 *
 * It is loaded from the sandboxed /api/plugins/<plugin>/src/<script> route, and
 * the SAME file is what a pop-out window loads in its own realm — so it must not
 * assume the app is there. `ctx` is everything it gets. See docs/plugin-panes.md.
 */
(function () {
    'use strict';

    const panes = window.feedBack && window.feedBack.panes;
    if (!panes) return;

    // Loaded factories, so re-opening a pane doesn't re-fetch its script.
    const loading = new Map();   // paneId -> Promise<factory>

    function _factory(paneId) {
        return window['feedBackPane_' + paneId] || null;
    }

    function _load(paneId, url) {
        const already = _factory(paneId);
        if (already) return Promise.resolve(already);
        if (loading.has(paneId)) return loading.get(paneId);

        const p = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = url;
            s.onload = () => {
                const f = _factory(paneId);
                if (f) resolve(f);
                else reject(new Error('pane script loaded but set no window.feedBackPane_' + paneId));
            };
            s.onerror = () => reject(new Error('failed to load pane script: ' + url));
            document.head.appendChild(s);
        });
        loading.set(paneId, p);
        p.catch(() => loading.delete(paneId));   // let a transient failure be retried
        return p;
    }

    function register(plugin, def) {
        const url = '/api/plugins/' + plugin.id + '/src/' + def.script;

        panes.register({
            id: def.id,
            title: def.title || def.id,
            icon: def.icon || '▣',
            // The pop-out realm loads exactly the same file.
            script: url,
            defaultHost: def.defaultHost || 'window',
            mirrorGlobal: def.mirrorGlobal || null,
            width: def.width || undefined,
            height: def.height || undefined,

            // The stub. Docked, the script is fetched on first open and its
            // factory takes over from here; the root is already on screen, so a
            // slow fetch shows an empty card rather than blocking the click.
            mount(root, ctx) {
                _load(def.id, url).then((factory) => {
                    if (!root.isConnected) return;   // closed again while we were fetching
                    factory.mount(root, ctx);
                    root.__fbPaneFactory = factory;
                }).catch((err) => {
                    console.error('[panes]', def.id, err);
                    const oops = document.createElement('div');
                    oops.className = 'fb-pane-dim';
                    oops.textContent = 'This pane failed to load.';
                    root.appendChild(oops);
                });
            },

            unmount(root, ctx) {
                const factory = root.__fbPaneFactory;
                delete root.__fbPaneFactory;
                // Only the factory that actually mounted gets to unmount. A pane
                // closed before its script arrived never mounted, and calling
                // unmount() on it would hand the plugin a root it has never seen.
                if (factory && typeof factory.unmount === 'function') {
                    try { factory.unmount(root, ctx); } catch (e) { console.error('[panes]', def.id, 'unmount threw', e); }
                }
                root.replaceChildren();
            },
        });
    }

    fetch('/api/plugins')
        .then((r) => r.json())
        .then((list) => {
            (Array.isArray(list) ? list : []).forEach((plugin) => {
                if (plugin.enabled === false || !Array.isArray(plugin.panes)) return;
                plugin.panes.forEach((def) => register(plugin, def));
            });
        })
        .catch((err) => console.error('[panes] could not read the plugin list', err));
})();
