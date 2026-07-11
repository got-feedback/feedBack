// The plugin loader — the R0 host rails.
//
// Carved verbatim out of static/app.js (R3a). This is the highest-risk module in
// core: it fetches /api/plugins, injects each plugin's screen.js (as
// <script type="module"> when its manifest says scriptType:"module"), mounts nav
// entries and screens, and wires plugin capability + UI contributions. If it
// breaks, every plugin breaks — so every change here ends with a real plugin
// booted against a local uvicorn, not just a green test run.
//
// The one thing it still needs from app.js is `window.showScreen` — already the
// public host contract (constitution II), so it is called through `window` rather
// than re-coupled as an import.
//
// `_populateVizPicker` used to arrive through a configurePluginLoader() host seam:
// it lived in app.js, and importing app.js from here would have closed a cycle.
// The viz layer is now its own leaf module, so the seam is GONE — this imports it
// directly, and the graph stays acyclic without any injection.
import { _populateVizPicker } from './viz.js';

let _loadPluginsInFlight = false;
const _pluginUiContributions = new Map();
const CAPABILITY_INSPECTOR_NAV_SETTING = 'capability_inspector.showInPluginsMenu';

function _capabilityInspectorNavEnabled() {
    try { return localStorage.getItem(CAPABILITY_INSPECTOR_NAV_SETTING) === '1'; }
    catch (_) { return false; }
}

// Derive a display label from a (possibly string) nav value. `/api/plugins`
// can return `nav` as a plain string (manifest `"nav": "Declared"`) or an
// object with a `.label`, and _pluginNav() may synthesize an object (e.g. the
// Capability Inspector). Handle all three so string labels and the synthesized
// label aren't dropped in favour of the plugin name.
function _navLabel(nav, plugin) {
    if (typeof nav === 'string' && nav.trim()) return nav;
    if (nav && typeof nav === 'object' && nav.label) return nav.label;
    return (plugin && (plugin.name || plugin.id)) || '';
}

function _pluginNav(plugin) {
    if (!plugin || !plugin.id) return null;
    if (plugin.id === 'capability_inspector') {
        if (!_capabilityInspectorNavEnabled()) return null;
        return plugin.nav || { label: 'Capabilities', screen: 'plugin-capability_inspector' };
    }
    return plugin.nav || null;
}

async function _commandUiDomain(domain, command, plugin, payload) {
    try {
        if (!window.feedBack?.capabilities?.command) return;
        await window.feedBack.capabilities.command(domain, command, {
            requester: plugin.id || 'plugin',
            target: { id: payload.id, pluginId: plugin.id, region: payload.region },
            payload: { ...payload, pluginId: plugin.id },
        });
    } catch (e) {
        console.warn(`ui contribution ${command} failed for ${plugin.id}:`, e);
    }
}

async function _registerLegacyPluginUiContributions(plugin) {
    const previous = _pluginUiContributions.get(plugin.id) || [];
    for (const contribution of previous) {
        await _commandUiDomain(contribution.domain, 'unmount', plugin, contribution);
    }
    const contributions = [];
    const nav = _pluginNav(plugin);
    if (nav) {
        contributions.push({ domain: 'ui.navigation', id: `${plugin.id}:nav`, region: 'plugins', label: _navLabel(nav, plugin), mounted: true });
    }
    if (plugin.has_screen) {
        contributions.push({ domain: 'ui.plugin-screens', id: `${plugin.id}:screen`, region: 'plugin-screens', label: plugin.name || plugin.id, mounted: true });
    }
    if (plugin.has_settings) {
        contributions.push({ domain: 'settings', id: `${plugin.id}:settings`, region: 'plugin-settings', label: plugin.name || plugin.id, mounted: true });
    }
    if (plugin.type === 'visualization') {
        contributions.push({ domain: 'ui.player-overlays', id: `${plugin.id}:visualization`, region: 'visualization-picker', label: plugin.name || plugin.id, mounted: true });
    }
    contributions.sort((a, b) => `${a.domain}:${a.id}`.localeCompare(`${b.domain}:${b.id}`));
    _pluginUiContributions.set(plugin.id, contributions);
    for (const contribution of contributions) {
        await _commandUiDomain(contribution.domain, 'register-contribution', plugin, contribution);
        await _commandUiDomain(contribution.domain, 'mount', plugin, contribution);
    }
}

// Settings-tab containers that can host plugin <details> panels on the v3
// tabbed settings page. '#plugin-settings' is the fallback bucket (and the
// only container in the classic v2 settings page); the per-tab containers map
// to a plugin manifest's settings.category. A plugin with no category, or one
// whose tab container is absent (v2, or render not yet run), falls back to
// '#plugin-settings'. Body divs injected per plugin use id
// `plugin-settings-<pluginId>` and live INSIDE a <details>, so they are never
// direct children of these containers — no id collision in the scans below.
const _PLUGIN_SETTINGS_CONTAINER_IDS = [
    'plugin-settings', 'plugin-settings-graphics',
    'plugin-settings-mic', 'plugin-settings-progression',
];
function _pluginSettingsContainers() {
    const out = [];
    for (const id of _PLUGIN_SETTINGS_CONTAINER_IDS) {
        const el = document.getElementById(id);
        if (el) out.push(el);
    }
    return out;
}
function _pluginSettingsTarget(plugin) {
    const cat = plugin && plugin.settings_category;
    if (cat) {
        const el = document.getElementById('plugin-settings-' + cat);
        if (el) return el;
    }
    return document.getElementById('plugin-settings');
}

export async function loadPlugins() {
    if (_loadPluginsInFlight) { console.log('[feedBack] loadPlugins: in-flight, skipping'); return null; }
    _loadPluginsInFlight = true;
    console.log('[feedBack] loadPlugins: start');
    let plugins;
    const navContainer = document.getElementById('nav-plugins');
    const mobileNavContainer = document.getElementById('mobile-nav-plugins');
    // Snapshot current nav so we can restore it if the fetch fails.
    const _savedNav = navContainer ? navContainer.innerHTML : null;
    const _savedMobileNav = mobileNavContainer ? mobileNavContainer.innerHTML : null;
    try {
        const resp = await fetch('/api/plugins');
        const fetchedPlugins = await resp.json();
        const capabilityPlugins = fetchedPlugins.slice().sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
        plugins = fetchedPlugins.slice().sort((a, b) => {
            const nameDelta = String(a.name || a.id || '').localeCompare(String(b.name || b.id || ''));
            return nameDelta || String(a.id || '').localeCompare(String(b.id || ''));
        });
        // NOTE deliberately NO stale-contribution sweep for plugins absent
        // from this response. Absent ≠ uninstalled: the backend clears its
        // plugin registry at the start of load_plugins() and repopulates it
        // incrementally while HTTP stays up, so every backend restart serves a
        // window of partial (even empty) responses. The old sweep unmounted UI
        // contributions and unregistered capability participants on mere
        // absence, permanently breaking still-loaded plugins — their scripts
        // don't re-run (loadedScripts guard below), so nothing ever
        // re-registered. A genuine mid-session uninstall now leaves the
        // (already-evaluated, un-unloadable) script's contributions in place
        // until reload; its nav entry still disappears because nav is rebuilt
        // from the response each round. Same invariant as the settings/screen
        // DOM wipe and _reconcilePluginStyles below.
        console.log('[feedBack] loadPlugins: got', plugins.length, 'plugins');

        try {
            const capabilityApi = window.feedBack?.capabilities;
            if (capabilityApi?.registerParticipants) {
                capabilityApi.registerParticipants(capabilityPlugins);
                if (capabilityApi.registerCompatibilityShim) {
                    for (const plugin of capabilityPlugins) {
                        for (const shim of Array.isArray(plugin.compatibility_shims) ? plugin.compatibility_shims : []) {
                            capabilityApi.registerCompatibilityShim(shim);
                        }
                    }
                }
                capabilityApi.validateRuntime?.({ phase: 'plugin-manifest-load' });
            }
        } catch (e) {
            console.warn('[feedBack] capability manifest registration failed:', e);
        }

        // Plugin settings panels mount into one of several tab containers —
        // see _pluginSettingsContainers()/_pluginSettingsTarget() above.

        // Plugins whose screen.js has already been evaluated this session
        // at the current version AND whose DOM is still in the document.
        // Their listeners were bound to the existing settings / screen DOM,
        // so we must preserve that DOM — the script load guard below skips
        // re-evaluating screen.js, and a fresh empty DOM with no listeners
        // would leave the plugin half-hydrated on subsequent loadPlugins()
        // calls (e.g. the streamed refetches in _streamPluginStartup).
        //
        // The DOM-existence check is the safety net for plugins that
        // disappeared and reappeared between calls (uninstall + reinstall,
        // or a backend snapshot churn that drops a plugin then restores
        // it). In that case the loadedScripts key would still be set, but
        // any listeners are bound to elements that have since been removed
        // — drop the stale key so screen.js re-runs against the fresh DOM
        // we're about to inject.
        // Map<pluginId, version> — one entry per plugin. Storing only the
        // currently-loaded version (rather than a Set of all (id, version)
        // pairs ever loaded) means upgrade → downgrade → upgrade cycles
        // within one session don't leave stale keys that could mistakenly
        // mark an old version as already-hydrated. Coerce a legacy Set, if
        // present, to an empty Map — the previous shape never shipped.
        let loadedScripts = window.feedBack._loadedPluginScripts;
        if (!(loadedScripts instanceof Map)) {
            loadedScripts = new Map();
            window.feedBack._loadedPluginScripts = loadedScripts;
        }
        const _removePluginScriptTags = (pluginId) => {
            // Filter via dataset rather than a CSS attribute selector —
            // CSS.escape is not universally available, and plugin IDs
            // aren't constrained server-side.
            document.querySelectorAll('script[data-plugin-id]').forEach((s) => {
                if (s.dataset.pluginId === pluginId) s.remove();
            });
        };
        // Mirror of loadedScripts for the plugin `styles` capability: a single
        // versioned <link rel=stylesheet> per plugin lives in <head>, deduped by
        // id → version so an upgrade swaps it and re-activation doesn't pile up
        // duplicate tags. The <link> covers both the plugin's screen and its
        // settings panel. Plugins ship preflight-off (utilities only) CSS, so a
        // stylesheet that lingers after deactivation can't bleed a base reset.
        let loadedStyles = window.feedBack._loadedPluginStyles;
        if (!(loadedStyles instanceof Map)) {
            loadedStyles = new Map();
            window.feedBack._loadedPluginStyles = loadedStyles;
        }
        const _removePluginStyleTags = (pluginId) => {
            // Same dataset-filter rationale as _removePluginScriptTags.
            document.querySelectorAll('link[data-plugin-id]').forEach((l) => {
                if (l.dataset.pluginId === pluginId) l.remove();
            });
        };
        const _injectPluginStyles = (plugin) => {
            // Tear down a <link> we injected earlier this session when the plugin
            // no longer ships a usable stylesheet — upgraded to drop `styles`, or
            // to an invalid path — so stale CSS can't keep applying after the
            // plugin disabled its styling.
            const teardownStale = () => {
                if (loadedStyles.has(plugin.id)) {
                    _removePluginStyleTags(plugin.id);
                    loadedStyles.delete(plugin.id);
                }
            };
            if (!plugin.has_styles || !plugin.styles) { teardownStale(); return; }
            // `styles` is a plugin-root-relative path (like screen/script/routes)
            // and must live under assets/ so it serves through the sandboxed
            // asset route — e.g. "assets/plugin.css". Reject anything that can't
            // reach a served file or would build a malformed URL: not under
            // assets/, a `..` traversal segment, a backslash, or a `?`/`#` that
            // would collide with the cache-busting query we append. The server
            // also enforces containment via safe_join — this just avoids the
            // wasted 404 and matches the documented contract.
            const path = String(plugin.styles).replace(/^\/+/, '');
            const unsafe = !path.startsWith('assets/')
                || /(^|\/)\.\.(\/|$)/.test(path)
                || /[\\?#]/.test(path);
            if (unsafe) {
                console.warn(`Plugin ${plugin.id}: styles must be a path under assets/ with no "..", backslash, or query/fragment (got "${plugin.styles}") — skipping`);
                teardownStale();
                return;
            }
            const wantedVersion = plugin.version || '';
            // Idempotent: same id+version already injected → nothing to do.
            if (loadedStyles.get(plugin.id) === wantedVersion) return;
            // A different version (or none) was loaded — drop the prior <link>
            // so we never accumulate stale stylesheets across upgrades.
            _removePluginStyleTags(plugin.id);
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.dataset.pluginId = plugin.id;
            link.dataset.pluginVersion = wantedVersion;
            // Version in the URL (the plugin `version`, mirroring the screen.js
            // loader's ?v= convention) so a plugin upgrade within one session
            // fetches fresh CSS instead of a copy cached by path alone.
            const v = encodeURIComponent(wantedVersion);
            link.href = `/api/plugins/${plugin.id}/${path}${v ? `?v=${v}` : ''}`;
            // Cascade ordering: insert this <link> BEFORE core's prebuilt
            // Tailwind (/static/tailwind.min.css) instead of appending at the
            // end of <head>. A plugin that ships a full utility build — the
            // default output of running the Tailwind CLI without a scoped
            // content config — re-defines core utilities like .grid /
            // .xl:grid-cols-4; appended last, those equal-specificity rules
            // would win on source order and clobber core's responsive layout
            // (e.g. the library grid collapses to 2 columns, the nav bar
            // breaks). Loading the plugin sheet first means core wins any
            // EQUAL-specificity collision, while the plugin's own namespaced
            // classes still apply. A plugin can still deliberately override core
            // via higher-specificity selectors or !important — this only removes
            // the accidental source-order clobber.
            const coreSheet =
                document.head.querySelector('link[rel="stylesheet"][href*="tailwind.min.css"]')
                || document.head.querySelector('link[rel="stylesheet"]');
            if (coreSheet) {
                document.head.insertBefore(link, coreSheet);
            } else {
                document.head.appendChild(link);
            }
            loadedStyles.set(plugin.id, wantedVersion);
        };
        const _reconcilePluginStyles = (currentPlugins) => {
            // Drop stylesheets for plugins the response KNOWS about but that
            // are no longer ready+styled this round. _injectPluginStyles below
            // only visits plugins still returned by the API, so a newly-not-
            // ready or unstyled plugin would otherwise keep its <link>
            // applying. Plugins merely ABSENT from the response keep their
            // stylesheet — a transient partial response during a backend
            // restart is not an uninstall (same invariant as the screen/
            // settings wipe below), and stripping the <link> would leave a
            // still-loaded plugin visible but unstyled.
            const responded = new Set(currentPlugins.map((p) => p.id));
            const styled = new Set(
                currentPlugins
                    .filter((p) => (p.status || 'ready') === 'ready' && p.has_styles && p.styles)
                    .map((p) => p.id),
            );
            for (const id of Array.from(loadedStyles.keys())) {
                if (responded.has(id) && !styled.has(id)) {
                    _removePluginStyleTags(id);
                    loadedStyles.delete(id);
                }
            }
        };
        const existingSettingsByPluginId = new Map();
        for (const container of _pluginSettingsContainers()) {
            for (const child of container.children) {
                const pid = child.dataset ? child.dataset.pluginId : null;
                if (pid) existingSettingsByPluginId.set(pid, child);
            }
        }
        // Plugins named in THIS response. A plugin can be transiently absent
        // from /api/plugins — the backend clears its registry at the start of
        // load_plugins() and repopulates it incrementally while HTTP stays up,
        // so every backend restart serves a window of partial (even empty)
        // responses. The wipe loops below must never treat that absence as an
        // uninstall: stripping a still-loaded plugin's DOM while keeping its
        // loadedScripts entry made the NEXT refetch fail the DOM check and
        // re-evaluate its screen.js mid-session — which duplicated the desktop
        // audio_engine's native signal chain (its init re-ran against the
        // surviving engine chain). Absent plugins keep their DOM and script;
        // they're re-reconciled when they reappear in a later response.
        const respondedIds = new Set(plugins.map((p) => p.id));
        const alreadyHydrated = new Set();
        for (const p of plugins) {
            if (!p.has_script) continue;
            // Version must match exactly — an upgrade / downgrade has to
            // re-run the new script against fresh DOM.
            if (loadedScripts.get(p.id) !== (p.version || '')) continue;
            const screenOk = !p.has_screen || !!document.getElementById(`plugin-${p.id}`);
            const settingsOk = !p.has_settings || existingSettingsByPluginId.has(p.id);
            if (screenOk && settingsOk) {
                alreadyHydrated.add(p.id);
            } else {
                // DOM was wiped externally (uninstall + reinstall, snapshot
                // churn) — drop the entry and remove the orphaned <script>
                // so screen.js re-runs against fresh DOM below.
                loadedScripts.delete(p.id);
                _removePluginScriptTags(p.id);
            }
        }

        // Clear plugin-owned containers, but keep already-hydrated plugins'
        // settings / screen DOM. Nav links carry no per-plugin script state,
        // so always rebuild them.
        navContainer.innerHTML = '';
        mobileNavContainer.innerHTML = '<span class="text-xs text-gray-600 uppercase tracking-wider">Plugins</span>';
        for (const container of _pluginSettingsContainers()) {
            [...container.children].forEach((el) => {
                const pid = el.dataset ? el.dataset.pluginId : null;
                // Remove junk (no plugin id) and plugins the response KNOWS
                // about but that failed hydration; leave plugins absent from
                // the response untouched (see respondedIds above).
                if (!pid || (respondedIds.has(pid) && !alreadyHydrated.has(pid))) el.remove();
            });
        }
        document.querySelectorAll('.screen[id^="plugin-"]').forEach((el) => {
            // dataset.pluginId is the source of truth (set on injection);
            // the id-prefix fallback covers screens injected before this
            // change shipped — both forms strip a single leading "plugin-".
            const pid = (el.dataset && el.dataset.pluginId)
                || el.id.replace(/^plugin-/, '');
            if (!pid || (respondedIds.has(pid) && !alreadyHydrated.has(pid))) el.remove();
        });

        // Plugin settings area hosts both "Plugin Updates" and per-plugin
        // collapsibles. Reveal it whenever any plugins are installed —
        // updates are relevant even for plugins that contribute no settings.
        if (plugins.length > 0) {
            const area = document.getElementById('plugin-settings-area');
            if (area) area.classList.remove('hidden');
        }

        // Build plugin dropdown for desktop nav
        const navPlugins = plugins.map(plugin => ({ plugin, nav: _pluginNav(plugin) })).filter(entry => entry.nav);
        if (navPlugins.length > 0) {
            const dropdown = document.createElement('div');
            dropdown.className = 'relative';
            dropdown.innerHTML = `
                <button class="text-sm text-gray-400 hover:text-white transition flex items-center gap-1" onclick="this.nextElementSibling.classList.toggle('hidden')">
                    Plugins
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
                </button>
                <div class="hidden absolute top-full left-0 mt-2 bg-dark-800 border border-gray-700 rounded-xl shadow-xl py-2 min-w-[180px] max-h-[80vh] overflow-y-auto z-50" id="plugin-dropdown"></div>`;
            navContainer.appendChild(dropdown);
            const ddMenu = dropdown.querySelector('#plugin-dropdown');

            // Close the plugin dropdown when clicking outside it. Bind ONCE:
            // loadPlugins() re-runs on every plugin status change during
            // startup (SSE-driven refetches), and each run rebuilds `dropdown`
            // / `ddMenu`. A per-run addEventListener would leak a new global
            // click listener on every refetch, each closing over a now-detached
            // dropdown. The one-time handler instead resolves the LIVE dropdown
            // from the DOM at click time, so it always targets the current one.
            if (!window.feedBack._pluginDropdownOutsideClickBound) {
                window.feedBack._pluginDropdownOutsideClickBound = true;
                document.addEventListener('click', (e) => {
                    const menu = document.getElementById('plugin-dropdown');
                    if (!menu) return;
                    const container = menu.parentElement;
                    if (container && !container.contains(e.target)) menu.classList.add('hidden');
                });
            }

            for (const { plugin, nav } of navPlugins) {
                const screenId = `plugin-${plugin.id}`;
                // A plugin is navigable only once it's ready. While its deps
                // install (status "installing") or after a failed load
                // (status "failed") we still render the nav slot — disabled,
                // with an "installing…" suffix or the error as a tooltip — so
                // the nav is stable and the user sees the plugin is coming
                // (#421). Entries without a status (legacy / stub) are ready.
                const status = plugin.status || 'ready';
                const isReady = status === 'ready';
                // nav is truthy here (navPlugins is filtered on entry.nav), and
                // is the computed value from _pluginNav() — which may be a
                // string, an object that omits `label`, or a synthesized object
                // (e.g. the Capability Inspector). _navLabel() normalizes all
                // three and falls back to name/id so a missing label never
                // renders "undefined" or throws. Use the loop's `nav`, not the
                // raw `plugin.nav`, so string and synthesized labels survive.
                const label = _navLabel(nav, plugin);

                const item = document.createElement('a');
                item.href = '#';
                ddMenu.appendChild(item);
                // Mobile nav — flat list
                const ma = document.createElement('a');
                ma.href = '#';
                mobileNavContainer.appendChild(ma);

                if (isReady) {
                    item.className = 'block px-4 py-2 text-sm text-gray-400 hover:text-white hover:bg-dark-700 transition';
                    item.textContent = label;
                    item.onclick = (e) => { e.preventDefault(); ddMenu.classList.add('hidden'); window.showScreen(screenId); window.feedBackDemoTrack?.('event/plugin-open/' + plugin.id); };
                    ma.className = 'text-gray-400 hover:text-white pl-4 text-sm';
                    ma.textContent = label;
                    ma.onclick = (e) => { e.preventDefault(); window.showScreen(screenId); ma.closest('#mobile-menu').classList.add('hidden'); window.feedBackDemoTrack?.('event/plugin-open/' + plugin.id); };
                } else {
                    const installing = status === 'installing';
                    const suffix = installing ? ' (installing…)' : ' (failed)';
                    const tip = installing
                        ? 'This plugin is installing its dependencies and will become available shortly.'
                        : (plugin.error || 'This plugin failed to load. Check the server startup log for details.');
                    // Disabled appearance: dimmed, default cursor, no nav handler.
                    const cls = 'block px-4 py-2 text-sm text-gray-600 cursor-default select-none'
                        + (installing ? ' animate-pulse' : '');
                    item.className = cls;
                    item.setAttribute('aria-disabled', 'true');
                    item.title = tip;
                    item.textContent = label + suffix;
                    // Drop disabled entries out of the tab order and strip the
                    // href so keyboard/screen-reader users don't land on a
                    // non-actionable "link" (a11y). Swallow clicks too, in case
                    // it's still reached via mouse.
                    item.removeAttribute('href');
                    item.setAttribute('tabindex', '-1');
                    item.onclick = (e) => { e.preventDefault(); };
                    ma.className = 'pl-4 text-sm text-gray-600 cursor-default select-none' + (installing ? ' animate-pulse' : '');
                    ma.setAttribute('aria-disabled', 'true');
                    ma.title = tip;
                    ma.textContent = label + suffix;
                    ma.removeAttribute('href');
                    ma.setAttribute('tabindex', '-1');
                    ma.onclick = (e) => { e.preventDefault(); };
                }
            }
        }

        // Tear down stylesheets for plugins that are gone / no longer styled
        // before (re)injecting for the current set.
        _reconcilePluginStyles(plugins);

        for (const plugin of plugins) {
            try {
            // Only ready plugins have their assets available (the backend
            // guards screen.html/screen.js/settings.html on status=="ready").
            // Installing/failed plugins contribute only the disabled nav slot
            // built above — skip screen/settings/script injection for them.
            if (plugin.status && plugin.status !== 'ready') continue;
            await _registerLegacyPluginUiContributions(plugin);
            const screenId = `plugin-${plugin.id}`;

            // Inject the plugin's stylesheet FIRST (before screen HTML/JS) so
            // its utilities are present on first paint. Idempotent + version-
            // deduped, so it's safe to call for already-hydrated plugins too.
            _injectPluginStyles(plugin);

            // Inject screen container. Skip for already-hydrated plugins —
            // their existing screen DOM still has the listeners that
            // screen.js bound on first load (rebuilding here would orphan
            // them, since the script load guard further down won't re-run
            // screen.js to re-bind).
            if (plugin.has_screen && !alreadyHydrated.has(plugin.id)) {
                const screenDiv = document.createElement('div');
                screenDiv.id = screenId;
                screenDiv.className = 'screen';
                screenDiv.dataset.pluginId = plugin.id;
                screenDiv.dataset.pluginVersion = plugin.version || '';
                // Insert before the player screen
                const player = document.getElementById('player');
                player.parentNode.insertBefore(screenDiv, player);

                const htmlResp = await fetch(`/api/plugins/${plugin.id}/screen.html`);
                screenDiv.innerHTML = await htmlResp.text();
            }

            // Inject settings section — wrapped in a collapsible <details>
            // per plugin so the page stays scannable as plugins accumulate.
            // Collapsed by default; <details>/<summary> handles state natively.
            // Skip for already-hydrated plugins — preserved details element
            // still carries listeners wired by its inline settings script
            // and by screen.js on first load.
            // Resolve which settings tab this plugin's panel mounts under
            // (manifest settings.category), falling back to '#plugin-settings'.
            const settingsTarget = plugin.has_settings ? _pluginSettingsTarget(plugin) : null;
            if (plugin.has_settings && settingsTarget && !alreadyHydrated.has(plugin.id)) {
                const details = document.createElement('details');
                details.className = 'bg-dark-700/40 border border-gray-800 rounded-xl overflow-hidden group';
                details.dataset.pluginId = plugin.id;
                details.dataset.pluginVersion = plugin.version || '';

                const summary = document.createElement('summary');
                // .plugin-settings-summary class hides the browser's native
                // disclosure triangle (see style.css) so only our chevron shows.
                // flex-col allows the fallback explanation note to appear below
                // the name/badges row when plugin.fallback is set.
                summary.className = 'plugin-settings-summary cursor-pointer select-none px-4 py-3 text-sm font-medium text-gray-300 hover:bg-dark-700/70 transition flex flex-col';
                // Inner row: plugin name/badges (left) + chevron (right).
                const headerRow = document.createElement('span');
                headerRow.className = 'flex items-center justify-between';
                const labelWrap = document.createElement('span');
                labelWrap.className = 'flex items-center gap-2';
                const labelSpan = document.createElement('span');
                labelSpan.textContent = plugin.name || plugin.id;
                labelWrap.appendChild(labelSpan);
                // "Bundled" marker (feedBack#160). Visually distinguishes
                // plugins that ship with the default container image from
                // user-installed ones so users don't try to remove a core
                // plugin via the manage-plugin flow and brick a feature
                // that's expected to "just work".
                if (plugin.bundled) {
                    const bundledDesc = 'This plugin ships with FeedBack core and is expected to be present.';
                    const badge = document.createElement('span');
                    badge.className = 'inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-purple-400/30 bg-purple-500/10 text-purple-300';
                    badge.title = bundledDesc;
                    badge.setAttribute('aria-label', 'Bundled — ' + bundledDesc);
                    badge.setAttribute('role', 'img');
                    badge.innerHTML = `
                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                  d="M12 11c1.657 0 3-1.343 3-3V6a3 3 0 10-6 0v2c0 1.657 1.343 3 3 3zM6 11h12a2 2 0 012 2v6a2 2 0 01-2 2H6a2 2 0 01-2-2v-6a2 2 0 012-2z"/>
                        </svg>
                        Bundled
                    `;
                    labelWrap.appendChild(badge);
                }
                // "Fallback" warning badge: the bundled copy failed to load its
                // routes, so the server fell back to this older user-installed
                // copy.  Warn users so they know the bundled build is broken and
                // can check the server startup log for the root cause.
                if (plugin.fallback) {
                    const fbBadge = document.createElement('span');
                    fbBadge.className = 'inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-yellow-400/40 bg-yellow-500/10 text-yellow-300';
                    fbBadge.setAttribute('aria-hidden', 'true');
                    fbBadge.innerHTML = '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg> Fallback';
                    labelWrap.appendChild(fbBadge);
                }
                // Assemble inner header row: [name/badges (left)] [chevron (right)].
                // Both are placed in headerRow so the fallback note (if any)
                // can sit below the entire row as a second flex-col child of
                // summary, rather than being squeezed inline beside the chevron.
                headerRow.appendChild(labelWrap);
                // Chevron icon — built via setAttributeNS so the SVG sits in
                // the SVG namespace and renders correctly. Plugin label is
                // appended as text above so manifest values can't inject HTML.
                const svgNS = 'http://www.w3.org/2000/svg';
                const svg = document.createElementNS(svgNS, 'svg');
                svg.setAttribute('class', 'w-4 h-4 text-gray-500 transition-transform group-open:rotate-180');
                svg.setAttribute('fill', 'none');
                svg.setAttribute('stroke', 'currentColor');
                svg.setAttribute('viewBox', '0 0 24 24');
                const svgPath = document.createElementNS(svgNS, 'path');
                svgPath.setAttribute('stroke-linecap', 'round');
                svgPath.setAttribute('stroke-linejoin', 'round');
                svgPath.setAttribute('stroke-width', '2');
                svgPath.setAttribute('d', 'M19 9l-7 7-7-7');
                svg.appendChild(svgPath);
                headerRow.appendChild(svg);
                summary.appendChild(headerRow);
                // Fallback explanation note: a visible <p> below the header row,
                // accessible to touch/keyboard users (browser tooltip via title/
                // aria-label alone is hover-only and insufficient). Appended to
                // summary (not labelWrap) so it renders as the second child in
                // summary's flex-col layout, appearing below the name+badges row.
                if (plugin.fallback) {
                    const fbNote = document.createElement('span');
                    fbNote.className = 'block text-xs text-yellow-300/80 mt-1';
                    fbNote.textContent = 'The bundled version failed to start. This user-installed copy is serving as a fallback. Check the server startup log for details.';
                    summary.appendChild(fbNote);
                }
                details.appendChild(summary);

                const body = document.createElement('div');
                body.id = `plugin-settings-${plugin.id}`;
                body.className = 'px-4 py-4 border-t border-gray-800 space-y-4';
                details.appendChild(body);

                settingsTarget.appendChild(details);

                const settingsResp = await fetch(`/api/plugins/${plugin.id}/settings.html`);
                body.innerHTML = await settingsResp.text();
                // <script> tags inserted via innerHTML are intentionally
                // inert per the HTML5 spec — the browser parses them as
                // DOM nodes but never runs the body. That silently breaks
                // any plugin settings.html that wires event handlers via
                // addEventListener (e.g. file pickers, anything that
                // can't be expressed as an inline onclick=… attribute),
                // and any inline IIFE that hydrates form values from
                // localStorage. Re-create each script node — script
                // elements created via document.createElement DO execute
                // when appended — so plugins get the script behavior
                // they'd expect from a normal HTML document.
                body.querySelectorAll('script').forEach(oldScript => {
                    const newScript = document.createElement('script');
                    for (const attr of oldScript.attributes) {
                        newScript.setAttribute(attr.name, attr.value);
                    }
                    newScript.textContent = oldScript.textContent;
                    oldScript.parentNode.replaceChild(newScript, oldScript);
                });

            }

            // Load plugin JS
            if (plugin.has_script) {
                const wantedVersion = plugin.version || '';
                if (loadedScripts.get(plugin.id) !== wantedVersion) {
                    // A different version (or none) was loaded previously —
                    // remove the prior <script> tag for this plugin id so we
                    // don't accumulate stale versions on upgrade/downgrade.
                    _removePluginScriptTags(plugin.id);
                    await new Promise((resolve, reject) => {
                        const script = document.createElement('script');
                        // Include version in URL so a plugin upgrade within the
                        // same browser session fetches the new screen.js instead
                        // of a cached copy keyed only by path (matches the art
                        // URL ?v=mtime convention elsewhere in this file).
                        const v = encodeURIComponent(wantedVersion);
                        script.src = `/api/plugins/${plugin.id}/screen.js${v ? `?v=${v}` : ''}`;
                        // Module-migration (R0): a migrated plugin declares
                        // scriptType:"module" and its screen.js is `import
                        // './src/main.js'`. A <script type="module"> fires load
                        // only after its whole static-import graph evaluates, so
                        // the await-onload completion + _loadingPluginId contract
                        // below is preserved (a classic-IIFE dynamic import()
                        // would not). Classic plugins are unaffected.
                        if (plugin.script_type === 'module') script.type = 'module';
                        script.dataset.pluginId = plugin.id;
                        script.dataset.pluginVersion = wantedVersion;
                        window.feedBack._loadingPluginId = plugin.id;
                        script.onload = () => {
                            if (window.feedBack._loadingPluginId === plugin.id) delete window.feedBack._loadingPluginId;
                            loadedScripts.set(plugin.id, wantedVersion);
                            resolve();
                        };
                        script.onerror = (err) => {
                            if (window.feedBack._loadingPluginId === plugin.id) delete window.feedBack._loadingPluginId;
                            loadedScripts.delete(plugin.id);
                            reject(err);
                        };
                        document.body.appendChild(script);
                    });
                }
            }
            } catch (e) {
                console.warn(`Plugin '${plugin.id}' failed to load, skipping:`, e);
            }
        }
    } catch (e) {
        console.error('Failed to load plugins:', e);
        // Restore nav so a failed re-hydration call doesn't leave it blank.
        if (_savedNav !== null && navContainer) navContainer.innerHTML = _savedNav;
        if (_savedMobileNav !== null && mobileNavContainer) mobileNavContainer.innerHTML = _savedMobileNav;
        _loadPluginsInFlight = false;
        return null;
    }
    _loadPluginsInFlight = false;
    return plugins;
}

// Re-run loadPlugins (and the viz picker, since a newly-ready plugin may
// register a window.feedBackViz_<id> factory) when plugin status changes.
// Debounced so a burst of plugin-registered/plugin-error events during
// startup collapses into a single refetch.
let _pluginRefreshTimer = null;
function _refreshPluginsSoon() {
    clearTimeout(_pluginRefreshTimer);
    _pluginRefreshTimer = setTimeout(async () => {
        const plugins = await loadPlugins();
        if (plugins) {
            _populateVizPicker(plugins);
        } else {
            // loadPlugins() returned null because a refetch was already in
            // flight, so this status change would otherwise be dropped. Re-arm
            // the debounce so the newer state is still applied once the
            // in-flight load finishes. Reuses the 250ms delay (and the
            // in-flight guard clears quickly), so this can't tight-loop.
            _refreshPluginsSoon();
        }
    }, 250);
}

let _pluginStreamStarted = false;
function _streamPluginStartup() {
    // Watch the SAME /api/startup-status/stream the splash used to gate on.
    // Instead of blocking, we let the nav render immediately (loadPlugins ran
    // already) and refetch whenever a plugin graduates to ready or fails — so
    // its nav slot flips from "installing…" to active/failed without a reload
    // (#421). loadPlugins is idempotent (in-flight guard + version map), so
    // extra refetches are cheap and safe.
    if (_pluginStreamStarted) return;
    _pluginStreamStarted = true;

    if (typeof EventSource === 'undefined') { _pollPluginStartup(); return; }

    const es = new EventSource('/api/startup-status/stream');
    es.onmessage = (event) => {
        let status;
        try { status = JSON.parse(event.data); } catch { return; }
        if (!status || status.type === 'keepalive') return;
        const phase = (status.phase || '').trim();
        if (phase === 'plugin-registered' || phase === 'plugin-error') {
            _refreshPluginsSoon();
        }
        // Terminal: one last refetch to catch anything missed, then stop.
        if (!status.running && (phase === 'complete' || phase === 'error')) {
            _refreshPluginsSoon();
            es.close();
        }
    };
    es.onerror = () => {
        // Stream dropped (proxy buffering, backend hiccup). Stop retrying the
        // stream and fall back to a bounded poll so late installs still surface.
        es.close();
        _pollPluginStartup();
    };
}

let _pollStartupStarted = false;
async function _pollPluginStartup() {
    // SSE-unavailable fallback: poll /api/startup-status until the backend
    // finishes its plugin loader, refetching whenever the ready count changes
    // or it goes terminal. Bounded so a backend that never finishes doesn't
    // poll forever.
    if (_pollStartupStarted) return;
    _pollStartupStarted = true;
    // Generous headroom over the documented worst case (whisperx → torch et al.
    // can take 20-30 min): a 30-min ceiling would stop polling right as a
    // slipping install — slow mirror, pip retry — actually finishes. 60 min
    // leaves margin so the late graduation still surfaces. (#421)
    const DEADLINE_MS = 60 * 60 * 1000;
    const start = Date.now();
    // Track a composite signature, not just the ready count: a plugin can fail
    // (phase → "plugin-error", current_plugin/error change) without changing
    // `loaded`, e.g. the next plugin breaks after all prior ones succeeded.
    // Watching only `loaded` would miss that transition until some later
    // ready-count change or terminal completion, so the failed/error nav state
    // wouldn't surface. Refetch whenever any of these move.
    let lastSig = null;
    while (Date.now() - start < DEADLINE_MS) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
            const resp = await fetch('/api/startup-status');
            if (!resp.ok) continue;
            const status = await resp.json();
            const sig = JSON.stringify([
                Number(status.loaded || 0),
                status.phase || '',
                status.current_plugin || '',
                status.error || '',
            ]);
            if (sig !== lastSig) { lastSig = sig; _refreshPluginsSoon(); }
            if (!status.running) { _refreshPluginsSoon(); return; }
        } catch (_e) { /* network error — keep trying */ }
    }
}

export async function bootstrapPluginsAndUi() {
    // #421: never gate the nav on full plugin startup. Render it immediately
    // from /api/plugins (ready plugins active; installing/failed disabled),
    // then stream plugin status so each entry resolves in place as its
    // dependencies finish installing or its load fails.
    const plugins = await loadPlugins();
    _streamPluginStartup();
    return plugins;
}


// ── Plugin updates ──────────────────────────────────────────────────────
// The Settings-screen "Check for updates" / "Update" buttons. Carved out of
// app.js (R3a) into the loader rather than a module of their own: this is plugin
// MANAGEMENT, it belongs with the code that loads them. Both are inline handlers,
// so app.js re-exposes them on window.

export async function checkPluginUpdates() {
    const btn = document.getElementById('btn-check-updates');
    const status = document.getElementById('updates-status');
    const list = document.getElementById('plugin-updates-list');
    btn.disabled = true;
    btn.textContent = 'Checking...';
    status.textContent = '';
    list.innerHTML = '';
    try {
        const resp = await fetch('/api/plugins/updates');
        const data = await resp.json();
        const updates = data.updates || {};
        const keys = Object.keys(updates);
        if (keys.length === 0) {
            status.textContent = 'All plugins are up to date.';
        } else {
            status.textContent = `${keys.length} update${keys.length > 1 ? 's' : ''} available`;
            for (const id of keys) {
                const u = updates[id];
                const row = document.createElement('div');
                row.className = 'flex items-center gap-3 bg-dark-700 rounded-lg px-4 py-2';
                row.innerHTML = `
                    <span class="text-sm text-gray-300 flex-1">${u.name} <span class="text-xs text-gray-500">(${u.behind} commit${u.behind > 1 ? 's' : ''} behind — ${u.local} → ${u.remote})</span></span>
                    <button onclick="updatePlugin('${id}', this)" class="bg-accent/20 hover:bg-accent/30 text-accent-light px-3 py-1 rounded-lg text-xs transition">Update</button>`;
                list.appendChild(row);
            }
        }
    } catch (e) {
        status.textContent = 'Failed to check for updates.';
    }
    btn.disabled = false;
    btn.textContent = 'Check for Updates';
}

export async function updatePlugin(pluginId, btn) {
    btn.disabled = true;
    btn.textContent = 'Updating...';
    try {
        const resp = await fetch(`/api/plugins/${pluginId}/update`, { method: 'POST' });
        const data = await resp.json();
        if (data.ok) {
            btn.textContent = 'Updated — restart to apply';
            btn.className = 'bg-green-900/30 text-green-400 px-3 py-1 rounded-lg text-xs';
        } else {
            btn.textContent = 'Failed';
            btn.title = data.error || '';
        }
    } catch (e) {
        btn.textContent = 'Error';
    }
}
