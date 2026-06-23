(function () {
    'use strict';

    // ─────────────────────────────────────────────────────────────────────────
    // FeedBack tour engine — consolidated menu version.
    //
    // One floating ? button at the bottom-right of the viewport. Click it to
    // see every tour that's relevant to the current screen. Click a tour to
    // start it (Shepherd-driven, same as before).
    //
    // Screen relevance defaults:
    //   - has_screen: true   → tour relevant on the plugin's own dedicated
    //                          screen (`plugin-<id>`)
    //   - otherwise          → tour relevant on the player screen
    //   - plugins can override via feedBackTour.register(id, { screens: [...] })
    //
    // First-visit toast: on screen:changed, if any relevant tour is unseen
    // and un-dismissed, a small "Take a quick tour of X?" prompt pops next
    // to the ? button (or queues if multiple). Same hasSeen/hasDismissed
    // logic as the previous design — no UX regression for users who've
    // already taken the per-plugin tours, just one button instead of N.
    // ─────────────────────────────────────────────────────────────────────────

    // _tourPlugins: { id, name, has_screen, is_viz } populated from /api/plugins
    //   (is_viz === true means the plugin declared type:"visualization" — used
    //   below to gate viz tours on the currently-active viz so we don't list
    //   tours whose DOM only exists when that viz is rendering).
    // _registry: imperative overrides keyed by plugin id — buildSteps,
    //   onStart, onComplete, plus an optional screens:[] override that
    //   wins over the defaults in _defaultScreensFor().
    const _tourPlugins = {};
    const _registry = {};
    const _deprecationWarned = new Set(); // pluginIds we've already warned about
    let _activeTour = null;
    let _activeTourPluginId = null;
    let _currentScreenId = null;
    let _menuBtn = null;       // the persistent ? button (lazily mounted)
    let _menuPopover = null;   // the menu of available tours
    let _activeToastPluginId = null; // plugin currently being prompted via toast

    // ── localStorage helpers ──────────────────────────────────────────────

    function _seenKey(id)      { return 'feedBack_tour_seen_' + id; }
    function _dismissedKey(id) { return 'feedBack_tour_dismissed_' + id; }

    function hasSeen(pluginId) {
        try { return !!localStorage.getItem(_seenKey(pluginId)); } catch { return false; }
    }
    function hasDismissed(pluginId) {
        try { return !!localStorage.getItem(_dismissedKey(pluginId)); } catch { return false; }
    }
    function _markSeen(pluginId)      { try { localStorage.setItem(_seenKey(pluginId), '1'); } catch { /* private mode / quota */ } }
    function _markDismissed(pluginId) { try { localStorage.setItem(_dismissedKey(pluginId), '1'); } catch { /* private mode / quota */ } }

    // ── Screen relevance ──────────────────────────────────────────────────

    function _defaultScreensFor(meta) {
        if (meta.has_screen) return ['plugin-' + meta.id];
        return ['player'];
    }

    function _screensFor(pluginId) {
        const reg = _registry[pluginId];
        if (reg && Array.isArray(reg.screens) && reg.screens.length) return reg.screens;
        const meta = _tourPlugins[pluginId];
        if (!meta) return [];
        return _defaultScreensFor(meta);
    }

    // Viz plugins' tours typically reference plugin-specific DOM that only
    // exists while that viz is rendering (e.g. 3D Highway's .h3d-wrap). On
    // the player screen we therefore only treat the active viz as relevant,
    // not every viz plugin that happens to ship a tour. Mirrors the same
    // localStorage/picker/auto-match precedence the previous per-plugin
    // _injectPlayerVizTrigger used.
    function _currentVizPluginId() {
        // Picker is the runtime source of truth — app.js treats
        // localStorage as a persistence mirror that can be stale or
        // unwritable (private mode / sandboxed contexts), so read the
        // picker first and only fall back to localStorage when it's
        // not in the DOM yet.
        const picker = document.getElementById('viz-picker');
        let sel = picker ? picker.value : null;
        if (!sel) {
            try { sel = localStorage.getItem('vizSelection'); } catch { /* private mode */ }
        }
        if (sel && sel !== 'auto' && sel !== 'default') return sel;
        if (sel !== 'auto') return null;

        const songInfo = (typeof highway !== 'undefined' && typeof highway.getSongInfo === 'function')
            ? (highway.getSongInfo() || {}) : {};
        const candidateIds = picker
            ? Array.from(picker.options).map(o => o.value).filter(v => v !== 'auto' && v !== 'default')
            : Object.keys(_tourPlugins).filter(id => _tourPlugins[id].is_viz);
        for (const pluginId of candidateIds) {
            const factory = window['feedBackViz_' + pluginId];
            if (typeof factory !== 'function') continue;
            const predicate = factory.matchesArrangement;
            if (typeof predicate !== 'function') continue;
            try { if (predicate(songInfo)) return pluginId; } catch { /* ignore */ }
        }
        return null;
    }

    // `activeVizId` is the precomputed result of _currentVizPluginId() for
    // this refresh — callers pass it in so we don't re-run the picker /
    // localStorage / matchesArrangement chain once per plugin per refresh.
    // Null is allowed: the gate falls open and viz plugins are never
    // relevant (matches "no viz active").
    function _isRelevant(pluginId, screenId, activeVizId) {
        if (!screenId) return false;
        if (_screensFor(pluginId).indexOf(screenId) === -1) return false;
        const meta = _tourPlugins[pluginId];
        if (meta && meta.is_viz && screenId === 'player') {
            return activeVizId === pluginId;
        }
        return true;
    }

    function _relevantPlugins(screenId) {
        // Resolve the active viz once and reuse across every plugin's
        // relevance check — the resolver can walk the picker options and
        // call matchesArrangement() predicates in auto mode, which is
        // wasted work per plugin.
        const activeVizId = (screenId === 'player') ? _currentVizPluginId() : null;
        return Object.values(_tourPlugins).filter(p => _isRelevant(p.id, screenId, activeVizId));
    }

    function _unseenRelevant(screenId) {
        // Drives the toast prompt + button "has-unseen" pulse. A tour registered
        // with autoPrompt:false is excluded — it's started programmatically by
        // its owner (e.g. the first-run home tour), so nagging via toast/pulse
        // would double up. It still lists in the menu and runs on demand.
        return _relevantPlugins(screenId).filter(p =>
            !hasSeen(p.id) && !hasDismissed(p.id) &&
            (_registry[p.id] ? _registry[p.id].autoPrompt !== false : true));
    }

    // ── Menu UI ────────────────────────────────────────────────────────────

    function _ensureMenu() {
        if (_menuBtn) return;
        _menuBtn = document.createElement('button');
        _menuBtn.className = 'feedBack-tour-menu-btn';
        _menuBtn.setAttribute('aria-label', 'Available tours');
        _menuBtn.setAttribute('aria-haspopup', 'dialog');
        _menuBtn.setAttribute('aria-expanded', 'false');
        _menuBtn.setAttribute('aria-controls', 'feedBack-tour-menu-popover');
        _menuBtn.title = 'Available tours';
        _menuBtn.textContent = '?';
        _menuBtn.style.display = 'none';
        _menuBtn.addEventListener('click', _toggleMenu);
        document.body.appendChild(_menuBtn);

        _menuPopover = document.createElement('div');
        _menuPopover.id = 'feedBack-tour-menu-popover';
        _menuPopover.className = 'feedBack-tour-menu-popover';
        // Plain popover; not a WAI-ARIA "menu" — that role implies roving
        // focus + arrow-key navigation we don't implement (the rows are
        // ordinary <button>s, traversed via normal tab order).
        _menuPopover.setAttribute('role', 'dialog');
        _menuPopover.setAttribute('aria-label', 'Available tours');
        _menuPopover.style.display = 'none';
        document.body.appendChild(_menuPopover);

        // Outside-click closes the menu (capture so we run before child handlers).
        document.addEventListener('pointerdown', (e) => {
            if (_menuPopover.style.display === 'none') return;
            const t = e.target;
            if (t && typeof t.closest === 'function' &&
                (t.closest('.feedBack-tour-menu-popover') || t.closest('.feedBack-tour-menu-btn'))) return;
            _hideMenu();
        }, true);

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && _menuPopover.style.display !== 'none') _hideMenu();
        });
    }

    function _showMenu() {
        if (!_menuPopover) return;
        _menuPopover.style.display = '';
        if (_menuBtn) _menuBtn.setAttribute('aria-expanded', 'true');
        // Move focus into the dialog so keyboard / screen-reader users
        // land on the first tour item rather than tabbing in from the
        // surrounding page. Pointer-only users are unaffected — the
        // focus ring only renders under :focus-visible.
        const firstItem = _menuPopover.querySelector('.tour-menu-item');
        if (firstItem) firstItem.focus();
    }
    function _hideMenu() {
        if (!_menuPopover) return;
        const wasOpen = _menuPopover.style.display !== 'none';
        _menuPopover.style.display = 'none';
        if (_menuBtn) {
            _menuBtn.setAttribute('aria-expanded', 'false');
            // Return focus to the trigger when closing — standard
            // dialog dismissal behavior so the user doesn't lose their
            // place in the tab order. Skipped when the popover wasn't
            // actually open (e.g. _updateMenuVisibility hides an
            // already-empty popover) to avoid stealing focus from
            // wherever the user happens to be. Also skipped when the
            // button itself is hidden (focus() is a no-op on
            // display:none elements and would leave focus in a stuck
            // state) — relevance dropped to zero and the user's
            // focus should fall back naturally to document.body.
            if (wasOpen && document.activeElement !== _menuBtn &&
                _menuPopover.contains(document.activeElement) &&
                _menuBtn.style.display !== 'none') {
                _menuBtn.focus();
            }
        }
    }
    function _toggleMenu() {
        if (!_menuPopover) return;
        if (_menuPopover.style.display === 'none') {
            _rebuildMenuItems();
            _showMenu();
            _dismissToast();
        } else {
            _hideMenu();
        }
    }

    function _rebuildMenuItems() {
        if (!_menuPopover) return;
        while (_menuPopover.firstChild) _menuPopover.removeChild(_menuPopover.firstChild);

        const plugins = _relevantPlugins(_currentScreenId);
        if (!plugins.length) {
            const empty = document.createElement('div');
            empty.className = 'tour-menu-empty';
            empty.textContent = 'No tours available on this screen.';
            _menuPopover.appendChild(empty);
            return;
        }

        const header = document.createElement('div');
        header.className = 'tour-menu-header';
        header.textContent = 'Available tours';
        _menuPopover.appendChild(header);

        plugins.forEach(p => {
            const row = document.createElement('button');
            row.className = 'tour-menu-item';
            row.dataset.pluginId = p.id;

            const label = document.createElement('span');
            label.className = 'tour-menu-item-label';
            label.textContent = p.name || p.id;
            row.appendChild(label);

            // Status badge — only rendered when there's something to show.
            // Three states: NEW (never seen + never dismissed), ✓ (completed
            // at least once), or no badge at all (dismissed without taking
            // the tour). The "dismissed but not seen" case used to render
            // an empty span — feedBack#272 review.
            const seen = hasSeen(p.id);
            const dismissed = hasDismissed(p.id);
            if (!seen && !dismissed) {
                const status = document.createElement('span');
                status.className = 'tour-menu-item-status is-new';
                status.textContent = 'NEW';
                row.appendChild(status);
            } else if (seen) {
                const status = document.createElement('span');
                status.className = 'tour-menu-item-status is-seen';
                status.textContent = '✓';
                row.appendChild(status);
            }

            row.addEventListener('click', () => {
                _hideMenu();
                _dismissToast();
                start(p.id);
            });

            _menuPopover.appendChild(row);
        });
    }

    function _updateMenuVisibility() {
        if (!_menuBtn) return;
        const plugins = _relevantPlugins(_currentScreenId);
        _menuBtn.style.display = plugins.length ? '' : 'none';
        if (!plugins.length) {
            _hideMenu();
            // Toast is position:fixed anchored to the now-hidden button
            // — left visible it'd float in dead space. Dismiss it too.
            _dismissToast();
        } else if (_menuPopover && _menuPopover.style.display !== 'none') {
            // Popover is currently open — rebuild rows so NEW/✓ badges,
            // newly registered plugins, and reset state all reflect
            // immediately rather than waiting for a close-and-reopen.
            _rebuildMenuItems();
        }

        // Unseen indicator on the menu button itself.
        if (_unseenRelevant(_currentScreenId).length) {
            _menuBtn.classList.add('has-unseen');
        } else {
            _menuBtn.classList.remove('has-unseen');
        }
    }

    // ── First-visit toast ─────────────────────────────────────────────────

    function _dismissToast() {
        if (!_activeToastPluginId) return;
        const id = _activeToastPluginId;
        _activeToastPluginId = null;
        document.querySelectorAll('.feedBack-tour-prompt').forEach(el => {
            if (el.dataset.pluginId === id) {
                el.classList.add('fading');
                setTimeout(() => el.remove(), 500);
            }
        });
    }

    function _maybeShowToast() {
        if (_activeToastPluginId) return; // already prompting
        // Don't pop a toast on top of an active tour either — song:ready
        // can fire mid-tour (user loads a new song while taking the tour)
        // and we don't want a "Take a quick tour of X?" prompt overlapping
        // the Shepherd UI for an unrelated plugin.
        if (_activeTour) return;
        if (!_menuBtn || _menuBtn.style.display === 'none') return;
        // Don't visually overlap the popover the user already opened —
        // the toast and the popover share the same screen anchor and
        // would steal attention from each other mid-interaction.
        if (_menuPopover && _menuPopover.style.display !== 'none') return;

        const unseen = _unseenRelevant(_currentScreenId);
        if (!unseen.length) return;
        const plugin = unseen[0];

        const prompt = document.createElement('div');
        prompt.className = 'feedBack-tour-prompt';
        prompt.dataset.pluginId = plugin.id;
        const text = document.createElement('span');
        text.textContent = 'Take a quick tour of ';
        const bold = document.createElement('b');
        bold.textContent = plugin.name || plugin.id;
        prompt.appendChild(text);
        prompt.appendChild(bold);
        prompt.appendChild(document.createTextNode('?'));

        if (unseen.length > 1) {
            const more = document.createElement('div');
            more.className = 'tour-prompt-more';
            more.textContent = '+ ' + (unseen.length - 1) + ' more available';
            prompt.appendChild(more);
        }

        const btns = document.createElement('div');
        btns.className = 'tour-prompt-buttons';

        const yesBtn = document.createElement('button');
        yesBtn.dataset.action = 'start';
        yesBtn.textContent = 'Yes';
        yesBtn.addEventListener('click', async () => {
            _activeToastPluginId = null;
            prompt.remove();
            // Hand persistence off to start() — its Shepherd handlers
            // mark seen on complete / dismissed on cancel. Marking
            // dismissed here would flip hasDismissed() to true while
            // the tour is still running, even after a successful
            // completion, suppressing the NEW state semantics.
            await start(plugin.id);
        });

        const noBtn = document.createElement('button');
        noBtn.dataset.action = 'dismiss';
        noBtn.textContent = 'Not now';
        noBtn.addEventListener('click', () => {
            _activeToastPluginId = null;
            _markDismissed(plugin.id);
            prompt.classList.add('fading');
            setTimeout(() => prompt.remove(), 500);
            _updateMenuVisibility();
        });

        btns.appendChild(yesBtn);
        btns.appendChild(noBtn);
        prompt.appendChild(btns);
        document.body.appendChild(prompt);
        _activeToastPluginId = plugin.id;

        // Auto-dismiss after 8 s.
        const timer = setTimeout(() => {
            if (_activeToastPluginId !== plugin.id) return;
            _activeToastPluginId = null;
            _markDismissed(plugin.id);
            prompt.classList.add('fading');
            setTimeout(() => prompt.remove(), 500);
            _updateMenuVisibility();
        }, 8000);

        const obs = new MutationObserver(() => {
            if (!document.contains(prompt)) { clearTimeout(timer); obs.disconnect(); }
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }

    // ── Step loading + Shepherd start ─────────────────────────────────────

    async function _loadSteps(pluginId) {
        if (_registry[pluginId] && typeof _registry[pluginId].buildSteps === 'function') {
            try {
                const steps = await _registry[pluginId].buildSteps();
                if (steps && steps.length) return steps;
            } catch (e) {
                console.warn('[feedBackTour] buildSteps() threw for', pluginId, e);
            }
        }
        try {
            const resp = await fetch('/api/plugins/' + encodeURIComponent(pluginId) + '/tour.json');
            if (!resp.ok) return [];
            const data = await resp.json();
            return Array.isArray(data.tour) ? data.tour : [];
        } catch (e) {
            console.warn('[feedBackTour] Failed to load steps for', pluginId, e);
            return [];
        }
    }

    // HTML-escape strings before handing them to Shepherd as a `title`,
    // since Shepherd renders titles via innerHTML. Plugin authors control
    // tour.json content but defense in depth is cheap: a typo with an
    // unescaped `&` or `<` in a title would otherwise silently corrupt
    // the rendered header, and a malicious / compromised plugin can't
    // inject markup or script tags via this surface.
    const _WAIT_FOR_TIMEOUT_MS = 5000;
    const _ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    function esc(s) {
        return String(s).replace(/[&<>"']/g, c => _ESC_MAP[c]);
    }

    function _mapSteps(rawSteps, tourInstance) {
        return rawSteps.map(raw => {
            const textEl = document.createElement('p');
            textEl.textContent = raw.content || '';

            const opts = {
                id: raw.id,
                title: esc(raw.title || ''),
                text: textEl,
                buttons: [
                    { text: 'Back', action: tourInstance.back.bind(tourInstance), secondary: true },
                    { text: 'Next', action: tourInstance.next.bind(tourInstance) },
                ],
                cancelIcon: { enabled: true },
            };

            if (raw.selector) {
                opts.attachTo = { element: raw.selector, on: raw.position || 'bottom' };
            }

            // waitFor lets a step block until its required DOM is in the
            // page. Useful when the consolidated menu can launch a tour
            // before the plugin's UI is fully mounted (e.g. 3D Highway's
            // .h3d-wrap appears after the first frame, but the user can
            // click "Take tour" before then). Polls with rAF up to
            // _WAIT_FOR_TIMEOUT_MS; resolves either way so the tour
            // doesn't hang — a still-missing selector will fail open at
            // attachTo and Shepherd will fall back to a centered tip.
            if (typeof raw.waitFor === 'string' && raw.waitFor) {
                const sel = raw.waitFor;
                // Try once up front so an invalid selector logs + resolves
                // immediately rather than hammering rAF and re-throwing
                // every frame.
                let selectorOk = true;
                try { document.querySelector(sel); }
                catch (e) {
                    selectorOk = false;
                    console.warn('[feedBackTour] step', raw.id, 'waitFor selector is invalid:', sel, e);
                }
                if (selectorOk) {
                    opts.beforeShowPromise = () => new Promise(resolve => {
                        const start = performance.now();
                        const tick = () => {
                            let found = false;
                            try { found = !!document.querySelector(sel); }
                            catch { return resolve(); } // selector became invalid mid-poll
                            if (found || performance.now() - start > _WAIT_FOR_TIMEOUT_MS) {
                                resolve();
                            } else {
                                requestAnimationFrame(tick);
                            }
                        };
                        tick();
                    });
                }
            }

            if (raw.shape === 'label') {
                opts.arrow = false;
            }

            if (raw.advance === 'click-target' && raw.selector) {
                opts.advanceOn = { selector: raw.selector, event: 'click' };
                opts.buttons = opts.buttons.filter(b => b.text !== 'Next');
                opts.buttons.push({ text: 'Skip', action: tourInstance.next.bind(tourInstance), secondary: true });
            }

            if (raw === rawSteps[0]) {
                opts.buttons = opts.buttons.filter(b => b.text !== 'Back');
            }
            if (raw === rawSteps[rawSteps.length - 1]) {
                opts.buttons = opts.buttons.map(b =>
                    (b.text === 'Next' || b.text === 'Skip')
                        ? { text: 'Done', action: tourInstance.complete.bind(tourInstance) }
                        : b
                );
            }

            return opts;
        });
    }

    async function start(pluginId) {
        if (typeof window.Shepherd === 'undefined' || !window.Shepherd.Tour) {
            console.error('[feedBackTour] Shepherd.js not loaded — cannot start tour for', pluginId);
            return false;
        }
        if (_activeTour) {
            _activeTour.cancel();
            _activeTour = null;
        }

        const rawSteps = await _loadSteps(pluginId);
        if (!rawSteps.length) {
            console.warn('[feedBackTour] No steps found for', pluginId);
            return false;
        }

        const hasSpotlight = rawSteps.some(s => s.shape === 'spotlight');

        const tour = new Shepherd.Tour({
            useModalOverlay: hasSpotlight,
            defaultStepOptions: {
                scrollTo: { behavior: 'smooth', block: 'center' },
                modalOverlayOpeningPadding: 8,
                modalOverlayOpeningRadius: 6,
            },
        });

        const mappedSteps = _mapSteps(rawSteps, tour);
        mappedSteps.forEach(s => tour.addStep(s));

        // Reset live state regardless of how the tour ended. Persistence
        // (seen vs dismissed) is decided by the handlers below — completing
        // the tour earns the ✓ badge, cancelling out mid-flight is treated
        // the same as the "Not now" toast (dismissed, no badge).
        const resetActive = () => {
            _activeTour = null;
            _activeTourPluginId = null;
            _updateMenuVisibility();
        };
        tour.on('complete', () => {
            _markSeen(pluginId);
            resetActive();
            _registry[pluginId]?.onComplete?.();
        });
        tour.on('cancel', () => {
            _markDismissed(pluginId);
            resetActive();
        });

        _activeTour = tour;
        _activeTourPluginId = pluginId;
        _registry[pluginId]?.onStart?.();
        tour.start();
        return true;
    }

    // ── screen:changed handler ────────────────────────────────────────────

    function _onScreenChanged(ev) {
        const screenId = ev.detail && ev.detail.id;
        if (!screenId) return;
        _currentScreenId = screenId;

        if (_activeTour && _activeTourPluginId) {
            const screens = _screensFor(_activeTourPluginId);
            if (screens.indexOf(screenId) === -1) {
                _activeTour.cancel();
                _activeTour = null;
                _activeTourPluginId = null;
            }
        }

        // Closing the toast on screen change — its anchor is the menu button,
        // and the menu may be hidden / repopulated on the new screen.
        _dismissToast();

        _updateMenuVisibility();
        _maybeShowToast();
    }

    // ── Public API ────────────────────────────────────────────────────────

    function register(pluginId, opts) {
        opts = opts || {};
        // injectTriggerInto / injectTriggerOpts are dropped — the consolidated
        // menu owns trigger placement. Warn once per plugin id so out-of-tree
        // plugins still calling with those options get the deprecation signal
        // without spamming the console on every reload / re-register.
        if (('injectTriggerInto' in opts || 'injectTriggerOpts' in opts) &&
            !_deprecationWarned.has(pluginId)) {
            _deprecationWarned.add(pluginId);
            console.warn(
                '[feedBackTour] register(' + JSON.stringify(pluginId) + '): ' +
                'injectTriggerInto / injectTriggerOpts are no longer honored — ' +
                'the consolidated tour menu (feedBack#272) manages the ? button ' +
                'for every plugin. Remove these options from your register() call.'
            );
        }
        _registry[pluginId] = {
            buildSteps: opts.buildSteps || null,
            onStart: opts.onStart || null,
            onComplete: opts.onComplete || null,
            screens: Array.isArray(opts.screens) ? opts.screens.slice() : null,
            // autoPrompt:false opts the tour OUT of the unseen toast + button
            // pulse (it's driven programmatically by its owner, e.g. the
            // first-run home tour started from onboarding). It still lists in the
            // menu and runs via start(). Defaults to the legacy always-prompt.
            autoPrompt: opts.autoPrompt !== false,
        };
        // A `name` registers a CLIENT/CORE-owned tour — one that isn't a
        // server-discovered plugin with a tour.json — into the consolidated menu
        // catalog so it appears in the "?" menu. Never clobber a richer entry the
        // /api/plugins pass already supplied for a real plugin of the same id.
        if (opts.name && !_tourPlugins[pluginId]) {
            _tourPlugins[pluginId] = {
                id: pluginId,
                name: opts.name,
                has_screen: true,
                is_viz: false,
            };
        }
        // If the override changes the relevance for the current screen, refresh.
        _updateMenuVisibility();
    }

    function reset(pluginId) {
        try {
            if (pluginId) {
                localStorage.removeItem(_seenKey(pluginId));
                localStorage.removeItem(_dismissedKey(pluginId));
            } else {
                const toRemove = [];
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    if (k && k.startsWith('feedBack_tour_')) toRemove.push(k);
                }
                toRemove.forEach(k => localStorage.removeItem(k));
            }
        } catch { /* private mode — ignore */ }
        _updateMenuVisibility();
    }

    window.feedBackTour = { register, start, hasSeen, hasDismissed, reset };

    // ── Initialise after DOM ──────────────────────────────────────────────

    document.addEventListener('DOMContentLoaded', async () => {
        if (!window.Shepherd) {
            console.error('[feedBackTour] Shepherd.js not loaded — tour engine disabled');
            return;
        }
        if (!window.feedBack) {
            console.error('[feedBackTour] window.feedBack not found — tour engine disabled');
            return;
        }

        try {
            const resp = await fetch('/api/plugins');
            if (!resp.ok) return;
            const plugins = await resp.json();
            plugins.filter(p => p.has_tour).forEach(p => {
                _tourPlugins[p.id] = {
                    id: p.id,
                    name: p.name,
                    has_screen: p.has_screen,
                    is_viz: p.type === 'visualization',
                };
            });
        } catch (e) {
            console.warn('[feedBackTour] Failed to load plugin list:', e);
            return;
        }

        _ensureMenu();
        window.feedBack.on('screen:changed', _onScreenChanged);
        // song:ready can change the auto-mode viz match without a screen
        // change — re-evaluate relevance so the menu picks up the new
        // active viz on the next song load.
        window.feedBack.on('song:ready', () => {
            _dismissToast();
            _updateMenuVisibility();
            _maybeShowToast();
        });

        // Initial pass: find the currently active screen, prime state.
        const screens = document.querySelectorAll('.screen.active');
        if (screens.length) {
            _currentScreenId = screens[0].id;
        }
        _updateMenuVisibility();
        _maybeShowToast();
    });
})();
