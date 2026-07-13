/*
 * fee[dB]ack — pane dock (the in-window pane host).
 *
 * A right-edge stack of cards, one per open pane. Deliberately NOT a rail popover:
 * the rail is exclusive (player-chrome.js's openPopFor closes the last one before
 * opening the next), which is exactly why you cannot watch the mixer while riding
 * the camera. Cards here coexist.
 *
 * As everywhere in this system, the card holds the plugin's REAL element — moved,
 * not copied. The dock is a frame; the panel inside it is the panel.
 *
 * Song-switch survival is structural, not defended: #fb-pane-dock is a <body>
 * child outside every .screen, so the per-song teardown never sees it.
 *
 * Registers as the `dock` host at priority 0 — the floor. Whatever else exists
 * (an OS window), a pane can always land here, so opening one can never fail.
 */
(function () {
    'use strict';

    const panes = window.feedBack && window.feedBack.panes;
    if (!panes || typeof panes.registerHost !== 'function') {
        console.error('[panes] pane-manager.js must load before pane-dock.js');
        return;
    }

    let dockEl = null;
    const cards = new Map();   // paneId -> card element

    function dock() {
        if (dockEl && dockEl.isConnected) return dockEl;
        dockEl = document.getElementById('fb-pane-dock');
        if (!dockEl) {
            dockEl = document.createElement('div');
            dockEl.id = 'fb-pane-dock';
            // `is-empty` from the start: panes.css hides an empty dock, and a dock
            // born without the class is a visible-to-CSS, announced-to-screen-readers
            // `role="region"` landmark with nothing in it until the first card
            // arrives. Born empty, because it is.
            dockEl.className = 'fb-pane-dock is-empty';
            dockEl.setAttribute('role', 'region');
            dockEl.setAttribute('aria-label', 'Panes');
            document.body.appendChild(dockEl);
        }
        return dockEl;
    }

    function _syncEmpty() {
        dock().classList.toggle('is-empty', cards.size === 0);
    }

    function place(spec, el) {
        const card = document.createElement('section');
        card.className = 'fb-pane-card';
        card.dataset.paneId = spec.id;
        card.setAttribute('aria-label', spec.title);

        const head = document.createElement('header');
        head.className = 'fb-pane-card-head';

        const title = document.createElement('span');
        title.className = 'fb-pane-card-title';
        // textContent, not innerHTML — a pane title comes from a plugin.
        title.textContent = spec.icon + ' ' + spec.title;

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'fb-pane-card-btn';
        close.setAttribute('aria-label', 'Close ' + spec.title);
        close.title = 'Close';
        close.textContent = '✕';
        close.addEventListener('click', () => panes.close(spec.id));

        head.appendChild(title);
        head.appendChild(close);

        const body = document.createElement('div');
        body.className = 'fb-pane-card-body';

        // Same neutralisation as the window host: the panel was a fixed overlay
        // pinned to a corner of the app, and inside a card that positioning is
        // nonsense. .fb-paned unpins it and nothing else.
        el.classList.add('fb-paned');
        body.appendChild(el);

        card.appendChild(head);
        card.appendChild(body);
        dock().appendChild(card);
        cards.set(spec.id, card);
        _syncEmpty();
    }

    function unplace(id, el) {
        // Hand the element back unmarked. The manager returns it to its home right
        // after this, and it must arrive as the plugin left it — a panel that
        // stayed .fb-paned would come back with its own positioning stripped.
        if (el) el.classList.remove('fb-paned');
        const card = cards.get(id);
        if (card) card.remove();
        cards.delete(id);
        _syncEmpty();
    }

    function focus(id) {
        const card = cards.get(id);
        if (!card) return;
        // Honour prefers-reduced-motion, as the flash animation below already does
        // in panes.css. A smooth scroll is motion too, and a user who asked for less
        // of it meant this as well.
        const calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        card.scrollIntoView({ block: 'nearest', behavior: calm ? 'auto' : 'smooth' });
        // Re-trigger the flash even if the class is still there — repeat focus of
        // the same card would otherwise be a no-op animation.
        card.classList.remove('is-flash');
        void card.offsetWidth;
        card.classList.add('is-flash');
        setTimeout(() => card.classList.remove('is-flash'), 700);
    }

    panes.registerHost({ id: 'dock', priority: 0, available: () => !!document.body, place, unplace, focus });
})();
