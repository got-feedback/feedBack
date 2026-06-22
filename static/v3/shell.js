/*
 * fee[dB]ack v0.3.0 — app shell: sidebar, topbar, client routing.
 *
 * Vanilla JS, no framework/bundler (constitution P-II). Reuses the engine
 * from app.js: navigation is the shared window.showScreen across both the new
 * #v3-* screens and the reused legacy/#plugin-* screens. UI placement is a
 * DEFERRED capability domain, so plugin nav/screens are consumed via the
 * legacy plugin loader + /api/plugins, NOT via capability dispatch
 * (design/05-capability-pipelines.md). All v3 UI state uses the `v3:` prefix.
 */
(function () {
    'use strict';

    // HTML-escape untrusted strings (plugin manifest id/label) before they go
    // into innerHTML, so a hostile/buggy manifest can't inject markup or event
    // attributes into the sidebar plugin nav.
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // ── Navigation registry ────────────────────────────────────────────────
    // Each entry maps a stable hash key → a screen id (showScreen target) and a
    // label. Legacy screens are reused: "Songs" = #home (library), "Favorites"
    // = #favorites, "Settings" = #settings. New screens use #v3-* ids.
    const NAV = [
        { key: 'home',       screen: 'v3-home',          label: 'Home',            group: 'HOME',    icon: 'home' },
        { key: 'progress',   screen: 'v3-progress',      label: 'Progress',        group: 'HOME',    icon: 'trophy' },
        { key: 'shop',       screen: 'v3-shop',          label: 'Unlockables',     group: 'HOME',    icon: 'tag' },
        { key: 'feedbarcade', screen: 'v3-feedbarcade',   label: 'FeedBarcade',    group: 'HOME',    icon: 'arcade' },
        { key: 'plugins',    screen: 'v3-plugins',       label: 'Plugins',         group: 'HOME',    icon: 'plug' },
        { key: 'settings',   screen: 'settings',         label: 'Settings',        group: 'HOME',    icon: 'gear' },
        { key: 'playlists',  screen: 'v3-playlists',     label: 'Playlists',       group: 'LIBRARY', icon: 'list' },
        { key: 'songs',      screen: 'v3-songs',         label: 'Songs',           group: 'LIBRARY', icon: 'disc' },
        { key: 'lessons',    screen: 'v3-lessons',       label: 'Lessons',         group: 'LIBRARY', icon: 'lessons' },
        { key: 'favorites',  screen: 'favorites',        label: 'Favorites',       group: 'LIBRARY', icon: 'star' },
        { key: 'saved',      screen: 'v3-saved',         label: 'Saved for Later', group: 'LIBRARY', icon: 'bookmark' },
        // Promoted plugins (group: null) — bundled plugins given their own
        // first-class sidebar entry instead of the generic plugin gallery. They
        // are placed by PROMOTED_PLUGINS below and their slots are filled by
        // renderPromotedNav() only when the plugin is actually installed. All
        // other plugins are reached solely via the single "Plugins" entry
        // above. Screens are injected async by the plugin loader, so go()'s
        // plugin- guard applies.
        { key: 'virtuoso',    screen: 'plugin-virtuoso',    label: 'Virtuoso - Practice', group: null, icon: 'target' },
        { key: 'rig_builder', screen: 'plugin-rig_builder', label: 'Rig Builder', group: null,      icon: 'amp' },
        { key: 'editor',      screen: 'plugin-editor',      label: 'Song Editor', group: null,      icon: 'edit' },
        // Not in the sidebar groups, but routable (profile badge → here).
        { key: 'profile',   screen: 'v3-profile',   label: 'Profile',         group: null,      icon: 'user' },
    ];
    // Bundled plugins promoted to dedicated sidebar entries. `anchorAfter` is
    // the nav key the slot is rendered immediately below (within that key's
    // group); a key that's the last item of the last group lands right after
    // that group. Each is gated on the plugin actually being installed.
    const PROMOTED_PLUGINS = [
        { navKey: 'virtuoso',    pluginId: 'virtuoso',    slotId: 'v3-nav-virtuoso',    anchorAfter: 'feedbarcade' },
        { navKey: 'rig_builder', pluginId: 'rig_builder', slotId: 'v3-nav-rig-builder', anchorAfter: 'saved' },
        { navKey: 'editor',      pluginId: 'editor',      slotId: 'v3-nav-editor',     anchorAfter: 'songs' },
    ];
    const TOPBAR_KEYS = ['home', 'songs', 'plugins', 'settings'];
    const SIDEBAR_GROUPS = ['HOME', 'LIBRARY'];

    // Minimal inline icon set (currentColor 24x24 stroke paths).
    const ICONS = {
        home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
        plug: 'M9 7V3m6 4V3M7 7h10v4a5 5 0 01-10 0V7zm5 9v5',
        gear: 'M12 9a3 3 0 100 6 3 3 0 000-6zm8.4 3a8.4 8.4 0 00-.1-1.3l2-1.6-2-3.4-2.4 1a8 8 0 00-2.2-1.3l-.4-2.6H9.7l-.4 2.6A8 8 0 007.1 6l-2.4-1-2 3.4 2 1.6a8.4 8.4 0 000 2.6l-2 1.6 2 3.4 2.4-1a8 8 0 002.2 1.3l.4 2.6h4.6l.4-2.6a8 8 0 002.2-1.3l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.3z',
        list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
        disc: 'M12 3a9 9 0 100 18 9 9 0 000-18zm0 6a3 3 0 100 6 3 3 0 000-6z',
        star: 'M12 3l2.9 6 6.6.9-4.8 4.6 1.1 6.5L12 18.8 6.2 21l1.1-6.5L2.5 9.9 9.1 9 12 3z',
        bookmark: 'M6 3h12a1 1 0 011 1v17l-7-4-7 4V4a1 1 0 011-1z',
        user: 'M12 12a4 4 0 100-8 4 4 0 000 8zm-7 8a7 7 0 0114 0',
        arcade: 'M7 8h10a4 4 0 014 4 4 4 0 01-4 4H7a4 4 0 01-4-4 4 4 0 014-4zm0 4h3m-1.5-1.5v3M15 11h.01M17.5 13h.01',
        lessons: 'M12 4L2 9l10 5 10-5-10-5zM6 11.5V16c0 1 2.7 2.5 6 2.5s6-1.5 6-2.5v-4.5',
        trophy: 'M8 21h8m-4-4v4m-6-17h12v5a6 6 0 01-12 0V4zm12 2h2a2 2 0 01-2 4M6 6H4a2 2 0 002 4',
        tag: 'M20.6 13.4l-7.2 7.2a2 2 0 01-2.8 0l-7-7V4h9.6l7.4 7.4a2 2 0 010 2zM7.5 7.5h.01',
        amp: 'M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zm11 4a3 3 0 100 6 3 3 0 000-6zM6.5 8.5h.01M9 8.5h.01',
        target: 'M12 3a9 9 0 100 18 9 9 0 000-18zm0 4a5 5 0 100 10 5 5 0 000-10zm0 4a1 1 0 100 2 1 1 0 000-2z',
        edit: 'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.1 2.1 0 013 3L12 15l-4 1 1-4 9.5-9.5z',
    };
    function iconSvg(name) {
        const d = ICONS[name] || ICONS.disc;
        return '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" stroke-width="1.8" ' +
            'viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="' + d + '"/></svg>';
    }

    const byKey = (k) => NAV.find((n) => n.key === k);
    const byScreen = (s) => NAV.find((n) => n.screen === s);
    const currentScreenId = () => (document.querySelector('.screen.active') || {}).id || 'v3-home';

    // The topbar IS each page's header row, so its title mirrors the screen.
    function titleFor(screenId) {
        if (screenId === 'v3-home') {
            const p = (window.v3Profile && window.v3Profile.get && window.v3Profile.get()) || null;
            return 'Welcome back, ' + ((p && p.display_name) || 'there') + '!';
        }
        const entry = byScreen(screenId);
        if (entry) return entry.label;
        if (screenId && screenId.indexOf('plugin-') === 0) return 'Plugins';
        return '';
    }
    function setTopbarTitle(text) {
        const el = document.getElementById('v3-topbar-title');
        if (el) el.textContent = text || '';   // textContent → no escaping needed
    }

    // ── Active-state sync ───────────────────────────────────────────────────
    function syncActive(screenId) {
        const entry = byScreen(screenId);
        document.querySelectorAll('[data-v3-nav]').forEach((el) => {
            const on = entry && el.getAttribute('data-v3-nav') === entry.key;
            el.classList.toggle('bg-fb-card', on);
            el.classList.toggle('text-fb-text', on);
            el.classList.toggle('text-fb-textDim', !on);
        });
        setTopbarTitle(titleFor(screenId));
        // NOTE: we deliberately do NOT reflect the screen into location.hash on
        // every navigation. app.js's audio 'error' handler suppresses empty-src
        // errors only when `audio.src === window.location.href`; a `#/...`
        // fragment makes href differ from the fragment-less resolved empty src,
        // so screen-switch audio cleanup would log a spurious media error (and
        // pollute the diagnostics console capture). Deep-linking IN is still
        // supported on load (see boot()); live reflection OUT is intentionally
        // omitted — it's optional per the prompt, console cleanliness is not.
    }

    // ── Navigation ──────────────────────────────────────────────────────────
    function go(screenId) {
        if (typeof window.showScreen !== 'function') return;
        // Guard plugin screens that may not be injected yet (loadPlugins runs
        // async at app.js boot). showScreen() throws on a missing element.
        if (screenId.indexOf('plugin-') === 0 && !document.getElementById(screenId)) {
            window.showScreen('v3-plugins');
            return;
        }
        window.showScreen(screenId);   // wrapper below re-syncs active state
        closeMobileSidebar();
    }

    // ── Sidebar ───────────────────────────────────────────────────────────--
    function navItemHTML(entry, labelOverride) {
        return '<a href="#/' + entry.key + '" data-v3-nav="' + entry.key + '" ' +
            'class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-fb-textDim ' +
            'hover:text-fb-text hover:bg-fb-card/50 transition-colors">' +
            iconSvg(entry.icon) + '<span class="truncate">' + esc(labelOverride != null ? labelOverride : entry.label) + '</span></a>';
    }
    // Empty slot for a promoted plugin, anchored after a nav item. Filled by
    // renderPromotedNav() only when the plugin is installed, so an absent
    // bundle shows nothing rather than a dead entry that bounces to Plugins.
    const promotedSlotHTML = (key) => PROMOTED_PLUGINS
        .filter((p) => p.anchorAfter === key)
        .map((p) => '<div id="' + p.slotId + '"></div>')
        .join('');
    function renderSidebar() {
        const nav = document.getElementById('v3-nav');
        if (!nav) return;
        let html = '';
        for (const group of SIDEBAR_GROUPS) {
            const items = NAV.filter((n) => n.group === group);
            if (!items.length) continue;
            const itemsHTML = items.map((it) => navItemHTML(it) + promotedSlotHTML(it.key)).join('');
            html += '<div><div class="px-3 mb-1 text-[10px] uppercase tracking-wider font-semibold text-fb-textDim/70">' +
                group + '</div><div class="space-y-0.5">' + itemsHTML + '</div></div>';
        }
        nav.innerHTML = html;
        nav.querySelectorAll('a[data-v3-nav]').forEach((a) => {
            a.addEventListener('click', (e) => {
                e.preventDefault();
                go(byKey(a.getAttribute('data-v3-nav')).screen);
            });
        });
    }

    // ── Topbar ───────────────────────────────────────────────────────────---
    function renderTopbar() {
        const bar = document.getElementById('v3-topbar');
        if (!bar) return;
        bar.className = 'sticky top-0 z-20 bg-fb-sidebar/80 backdrop-blur';
        bar.innerHTML =
            // Row 1 — top utility bar: search.
            '<div class="flex items-center gap-4 px-4 md:px-8 pt-4">' +
            '<button id="v3-hamburger" class="md:hidden text-fb-textDim hover:text-fb-text shrink-0" aria-label="Menu">' +
            '<svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16"/></svg></button>' +
            '<div class="flex-1 max-w-md relative">' +
            '<svg class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-fb-textDim" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path stroke-linecap="round" d="M21 21l-4-4"/></svg>' +
            '<input id="v3-search" type="search" placeholder="Search songs…" aria-label="Search songs" ' +
            'class="w-full bg-gray-800/50 border border-gray-700 rounded-md pl-10 pr-4 py-2 text-sm ' +
            'text-fb-text placeholder-fb-textDim focus:border-fb-primary focus:ring-1 focus:ring-fb-primary outline-none"></div>' +
            '</div>' +
            // Row 2 — page header: title + ONLY the tuner/instrument/profile
            // badge cluster on the same line as the header.
            '<div class="flex items-center gap-3 px-4 md:px-8 pt-2 pb-4">' +
            '<h1 id="v3-topbar-title" class="text-2xl md:text-3xl font-bold text-fb-text truncate min-w-0 flex-1"></h1>' +
            '<div class="flex items-center gap-2 shrink-0">' +
            '<span id="v3-badge-tuner" class="contents"></span>' +
            '<span id="v3-badge-instrument" class="contents"></span>' +
            '<span id="v3-badge-profile" class="contents"></span>' +
            '</div></div>';

        const burger = document.getElementById('v3-hamburger');
        if (burger) burger.addEventListener('click', toggleMobileSidebar);
        setTopbarTitle(titleFor(currentScreenId()));

        // Search drives the native Songs screen (prompt 21). Debounced so we
        // don't refetch on every keystroke. Degrades silently if v3Songs isn't
        // loaded yet.
        const search = document.getElementById('v3-search');
        if (search) {
            let t = 0;
            search.addEventListener('input', () => {
                if (t) clearTimeout(t);
                t = setTimeout(() => {
                    if (window.v3Songs && typeof window.v3Songs.search === 'function') window.v3Songs.search(search.value);
                }, 250);
            });
        }
    }

    // ── Responsive sidebar ───────────────────────────────────────────────---
    function ensureBackdrop() {
        let bd = document.getElementById('v3-sidebar-backdrop');
        if (!bd) {
            bd = document.createElement('div');
            bd.id = 'v3-sidebar-backdrop';
            bd.className = 'fixed inset-0 bg-black/60 z-40 md:hidden hidden';
            bd.addEventListener('click', closeMobileSidebar);
            document.body.appendChild(bd);
        }
        return bd;
    }
    function toggleMobileSidebar() {
        const sb = document.getElementById('v3-sidebar');
        const bd = ensureBackdrop();
        if (!sb) return;
        const opening = sb.classList.contains('hidden');
        sb.classList.toggle('hidden', !opening);
        // On mobile, float the sidebar over content.
        sb.classList.toggle('flex', opening);
        sb.classList.toggle('fixed', opening);
        sb.classList.toggle('inset-y-0', opening);
        sb.classList.toggle('left-0', opening);
        sb.classList.toggle('z-50', opening);
        bd.classList.toggle('hidden', !opening);
    }
    function closeMobileSidebar() {
        if (window.matchMedia && window.matchMedia('(min-width: 768px)').matches) return;
        const sb = document.getElementById('v3-sidebar');
        const bd = document.getElementById('v3-sidebar-backdrop');
        if (sb) {
            sb.classList.add('hidden');
            sb.classList.remove('flex', 'fixed', 'inset-y-0', 'left-0', 'z-50');
        }
        if (bd) bd.classList.add('hidden');
    }

    // ── Promoted-plugin nav (legacy loader is the source; UI domain deferred) ─
    // Individual plugins are NOT listed in the sidebar — the single "Plugins"
    // entry (HOME group) is the one entry point to the plugin gallery. The
    // PROMOTED_PLUGINS get their own first-class slots, each filled here only
    // when that plugin is actually installed.
    async function renderPromotedNav() {
        let plugins = [];
        try {
            const res = await fetch('/api/plugins');
            if (res.ok) plugins = await res.json();
        } catch (e) { return; } // degrade: no promoted slots
        const list = Array.isArray(plugins) ? plugins : [];
        for (const promo of PROMOTED_PLUGINS) {
            const host = document.getElementById(promo.slotId);
            const entry = byKey(promo.navKey);
            if (!host || !entry) continue;
            const plugin = list.find((p) => p && p.id === promo.pluginId);
            if (!plugin) continue; // not installed → empty slot
            // Use the plugin's own nav label (manifest), falling back to the
            // static NAV label. navItemHTML escapes it.
            const label = (plugin.nav && plugin.nav.label) || plugin.name || entry.label;
            host.innerHTML = '<div class="space-y-0.5">' + navItemHTML(entry, label) + '</div>';
            const a = host.querySelector('a[data-v3-nav]');
            if (a) a.addEventListener('click', (e) => { e.preventDefault(); go(entry.screen); });
        }
    }

    // ── showScreen wrapper (idempotent rehydration — design/05 §Rehydration) ─
    function installShowScreenHook() {
        const hooks = window.__slopsmithV3ShellHooks || (window.__slopsmithV3ShellHooks = {});
        hooks.syncActive = syncActive; // always point at the latest impl
        if (hooks.installed) return;
        hooks.installed = true;
        hooks.baseShowScreen = window.showScreen;
        window.showScreen = function (id) {
            // Route every "go to the library" navigation to the v3 native Songs
            // screen instead of the legacy #home library, so player-close,
            // settings-back, the hidden legacy navbar, etc. all stay in v3.
            const target = (id === 'home') ? 'v3-songs' : id;
            const r = hooks.baseShowScreen ? hooks.baseShowScreen.call(this, target) : undefined;
            try { hooks.syncActive && hooks.syncActive(target); } catch (e) { /* non-fatal */ }
            return r;
        };
    }

    // ── Boot ────────────────────────────────────────────────────────────────
    async function boot() {
        if (window.fbBrand) window.fbBrand.renderWordmark(document.getElementById('v3-brand'), { size: 'text-xl' });
        renderSidebar();
        renderTopbar();
        ensureBackdrop();
        installShowScreenHook();
        renderPromotedNav(); // async, non-blocking

        // First-run gate: onboarding overlay is owned by prompt 15. Until it
        // exists, degrade gracefully and go straight to the dashboard.
        let profile = null;
        try {
            const res = await fetch('/api/profile');
            if (res.ok) profile = await res.json();
        } catch (e) { /* profile endpoint lands in prompt 15 */ }
        if (profile && profile.onboarded === false && window.v3Onboarding && typeof window.v3Onboarding.show === 'function') {
            try { window.v3Onboarding.show(profile); } catch (e) { /* fall through */ }
        }

        // Splitscreen pop-out windows (`?ssFollower=1`) get sent to
        // showScreen('player') by app.js's bootstrap (app.js:9716) before
        // this runs, exactly so the library doesn't flash on the popup.
        // Don't undo that here — the splitscreen IIFE loads next and takes
        // the popup the rest of the way into follower mode. Without this
        // bail, the default 'v3-home' target below would re-activate the
        // library screen and bring the flash back.
        let isFollowerWindow = false;
        try { isFollowerWindow = new URLSearchParams(location.search).get('ssFollower') === '1'; }
        catch (_) { /* file:// or sandboxed iframe — fall through */ }
        if (isFollowerWindow) {
            syncActive('player');
        } else {
            // Deep-link IN on load: honor a #/key fragment, then strip it so
            // subsequent screen-switch audio cleanup doesn't trip app.js's
            // href-based empty-src guard (see syncActive). #v3-home is already
            // `.active` in the HTML, so when that's the target we only sync the
            // chrome — calling showScreen() redundantly would run its non-player
            // teardown branch and log a spurious "Empty src" media error.
            const m = (location.hash || '').match(/^#\/([\w-]+)/);
            const entry = m && byKey(m[1]);
            if (location.hash) {
                try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* file:// */ }
            }
            const target = entry ? entry.screen : 'v3-home';
            const el = document.getElementById(target);
            if (el && el.classList.contains('active')) {
                syncActive(target);
            } else {
                go(target);
            }
        }

        // The "Welcome back, {name}!" title needs the profile, which loads
        // async — refresh once it's in (and whenever it changes).
        function refreshHomeTitle() { if (currentScreenId() === 'v3-home') setTopbarTitle(titleFor('v3-home')); }
        if (window.slopsmith && typeof window.slopsmith.on === 'function') {
            window.slopsmith.on('v3:profile-updated', refreshHomeTitle);
        }
        setTimeout(refreshHomeTitle, 700);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
