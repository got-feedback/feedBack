/*
 * fee[dB]ack — pane runtime (the pop-out realm).
 *
 * This is what runs inside a pane window. It is NOT the app: there is no
 * highway, no library, no shell, no <audio>, no capability bus, no audio graph.
 * There is this file, the bridge, and the pane's own script.
 *
 * That is deliberate. The splitscreen follower reuses the full app shell with a
 * `?ssFollower=1` flag and pays for it — an anti-flash block that must run before
 * any script parses, bail-outs in app.js and shell.js, and ~40 lines of CSS
 * hiding core elements by id. It loads the whole app to throw it away. A pane
 * window has nothing to throw away.
 *
 * The cost is that `window.feedBack` here is a deliberate, documented SUBSET.
 * We install exactly what a pane is promised and nothing more, so a pane reaching
 * for something it was never given fails loudly at authoring time instead of
 * subtly at runtime.
 *
 * Boot: hello → snapshot → load the pane's script → mount(root, ctx).
 */
(function () {
    'use strict';

    const B = window.__fbPaneBridge;
    const params = new URLSearchParams(location.search);
    const paneId = params.get('pane');
    const scriptUrl = params.get('script');

    const rootEl = document.getElementById('pane-root');
    const titleEl = document.getElementById('pane-title');
    const statusEl = document.getElementById('pane-status');

    function fail(message) {
        statusEl.textContent = message;
        statusEl.hidden = false;
        rootEl.hidden = true;
    }

    if (!paneId || !scriptUrl) { fail('This window was opened without a pane to show.'); return; }
    if (!B) { fail('Pane bridge failed to load.'); return; }

    const channel = B.openChannel();
    if (!channel) { fail('This browser has no BroadcastChannel, so a pane window cannot be kept in sync.'); return; }

    // The registration shim. A pane script is the SAME file whether it runs in the
    // app (where it registers with the real pane manager) or here — it calls
    // `feedBack.panes.register(spec)` either way. Here, that call just hands us
    // the spec.
    let captured = null;
    window.feedBack = {
        panes: {
            register(spec) {
                if (spec && spec.id === paneId) captured = spec;
                return () => {};
            },
            // A pane window hosts one pane. Chip/dock/launcher calls are
            // meaningless here, but a shared pane script may make them at load —
            // so they must exist and do nothing rather than throw and take the
            // pane's module down with them.
            attachChip: () => () => {},
            get: () => null,
            isOpen: () => false,
            list: () => [],
        },
    };

    const transport = B.createRemoteTransport(paneId, 'pane:' + paneId, channel);
    let ctx = null;
    let mounted = false;

    channel.addEventListener('message', (e) => {
        const msg = e.data;
        if (!msg || msg.v !== B.PROTOCOL_VERSION || msg.paneId !== paneId) return;
        if (msg.hostId !== 'main') return;   // ignore our own echoes

        if (msg.type === 'snapshot') { onSnapshot(msg.payload); return; }

        if (msg.type === 'bye') {
            const reason = (msg.payload && msg.payload.reason) || '';
            // 'main-closed' is the interesting one: nothing will ever feed this
            // window again. Say so plainly rather than leaving a frozen playhead
            // that looks live.
            if (reason === 'main-closed') fail('fee[dB]ack closed. This pane is no longer live.');
            else window.close();   // closed deliberately from the app side
            return;
        }

        if (msg.type === 'state' && state) {
            // The authoritative echo. Applying it unconditionally is what makes a
            // losing write self-correct.
            state.set(msg.payload.path, msg.payload.value);
            return;
        }

        transport.handle(msg);
    });

    let state = null;

    function onSnapshot(snap) {
        if (mounted) return;   // a duplicate snapshot (main reloaded) — the window will be told `bye` if stale
        titleEl.textContent = snap.spec.icon + ' ' + snap.spec.title;
        document.title = snap.spec.title + ' — fee[dB]ack';
        transport.setSong(snap.song);

        state = B.createStateStore(snap.state);
        // A pane's write is a REQUEST. We send it and let the main realm's echo
        // apply it, so there is exactly one authority and no split brain. The
        // local store is not written here — the echo does that.
        const authoritative = {
            get: (path) => state.get(path),
            all: () => state.all(),
            subscribe: (fn) => state.subscribe(fn),
            set: (path, value) => {
                channel.postMessage(B.envelope('state', paneId, 'pane:' + paneId, { path, value }));
                return true;
            },
        };

        ctx = B.createCtx({
            paneId: paneId,
            host: 'pane:' + paneId,
            transport: transport,
            state: authoritative,
            onClose: () => window.close(),
        });

        loadScript(snap.spec.script).then(() => {
            // Two ways a script can hand us a pane, and the same file must work in
            // both realms:
            //   - a plugin pane sets window.feedBackPane_<id> (the factory global,
            //     mirroring the existing window.feedBackViz_<id> contract), because
            //     the main realm loads it lazily and must not have to re-register;
            //   - a core built-in calls feedBack.panes.register(), which our shim
            //     above captured.
            const pane = window['feedBackPane_' + paneId] || captured;
            if (!pane || typeof pane.mount !== 'function') {
                fail('The pane script loaded but provided no pane.');
                return;
            }
            statusEl.hidden = true;
            rootEl.hidden = false;
            try {
                pane.mount(rootEl, ctx);
                mounted = true;
            } catch (err) {
                console.error('[pane] mount() threw', err);
                fail('This pane failed to start.');
            }
        }).catch((err) => {
            console.error('[pane] failed to load', snap.spec.script, err);
            fail('Could not load this pane.');
        });
    }

    function loadScript(url) {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = url;
            s.onload = resolve;
            s.onerror = () => reject(new Error('script load failed: ' + url));
            document.head.appendChild(s);
        });
    }

    // Tell the app we're gone so it can un-hide the dialog the chip hid. If this
    // never arrives (a crash), the host's `closed` poll reaps us anyway — but the
    // clean path should not depend on the fallback.
    window.addEventListener('beforeunload', () => {
        try { channel.postMessage(B.envelope('bye', paneId, 'pane:' + paneId, { reason: 'pane-closed' })); }
        catch (e) { /* channel already torn down */ }
    });

    // Resync-on-open, always: the snapshot is the only way this realm learns
    // anything, so ask for it as the very first thing we do.
    channel.postMessage(B.envelope('hello', paneId, 'pane:' + paneId, {}));

    // If nobody answers, the main window is gone or never had this pane. Don't
    // spin forever on a blank window.
    setTimeout(() => { if (!mounted && !state) fail('fee[dB]ack is not running, or this pane is no longer available.'); }, 5000);
})();
