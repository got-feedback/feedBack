// Demo analytics — real impl set by demo.js; no-op in normal builds
window.feedBackDemoTrack = window.feedBackDemoTrack ?? null;

// Sync the play/pause button's icon and accessible state in one place so
// screen readers, tooltips, and aria-pressed stay aligned with playback.
// Updates the existing <img> child's src in place rather than rewriting
// innerHTML, so any future children (fallback label, loading spinner, …)
// survive state changes.
function setPlayButtonState(isPlaying) {
    const btn = document.getElementById('btn-play');
    if (!btn) return;
    const label = isPlaying ? 'Pause' : 'Play';
    const icon = isPlaying ? 'pause' : 'play';
    let img = btn.querySelector('img.button-icon-svg');
    if (!img) {
        img = document.createElement('img');
        img.className = 'button-icon-svg';
        img.alt = '';
        img.setAttribute('aria-hidden', 'true');
        btn.appendChild(img);
    }
    img.src = `/static/svg/${icon}.svg`;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', isPlaying ? 'true' : 'false');
    btn.title = label;
}

// ── Global keyboard shortcuts ─────────────────────────────────────────────
//
// `/` focuses the active screen's search input (Library / Favorites);
// `Esc` while focused blurs and clears it. Mirrors the GitHub / Gmail
// convention. The listener bails when the user is already typing in
// any text-accepting element so it can't intercept normal typing —
// including inputs inside the filters drawer, plugin settings, or
// modal dialogs.
function _isTextInput(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT') {
        // Some <input> types (button, checkbox, radio, range, ...) don't
        // accept text; only intercept the ones that do.
        const t = (el.type || 'text').toLowerCase();
        return ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(t);
    }
    if (tag === 'TEXTAREA') return true;
    if (tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
}

function _isShortcutHelpKey(e) {
    return e.key === '?' || (e.shiftKey && (e.code === 'Slash' || e.key === '/'));
}

function _isShortcutHelpSuppressedTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT') {
        const t = (el.type || 'text').toLowerCase();
        return ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(t);
    }
    if (tag === 'TEXTAREA') return true;
    if (el.isContentEditable) return true;
    if (el.closest && el.closest('#lib-filter-drawer, [role="dialog"], #edit-modal, .feedBack-modal')) return true;
    return false;
}

function _activeSearchInput() {
    // Pick the search field for whichever screen is currently active.
    // No match (e.g. on the player or settings screen) means `/` does
    // nothing — the shortcut only fires where a search box exists.
    const active = document.querySelector('.screen.active');
    if (!active) return null;
    if (active.id === 'home') return document.getElementById('lib-filter');
    if (active.id === 'favorites') return document.getElementById('fav-filter');
    return null;
}

// ── Library keyboard navigation ──────────────────────────────────────────
//
// Arrow keys move a single "selected" item among the visible cards
// (grid view) or song rows (tree view). Enter plays the selected
// song. The selected element gets:
//   - native keyboard focus via .focus() so :focus-visible draws the
//     accessible ring (announced by screen readers, follows scroll)
//   - a `.selected` class that persists when focus drifts elsewhere
//     so the user can glance back and still see their place.
//
// Grid columns are inferred from the live computed grid template at
// the moment of navigation, so up/down works correctly across all
// breakpoints (1 / 2 / 3 / 4 cols depending on viewport).

function _isElementVisible(el) {
    // Walk ancestors looking for display:none. Handles collapsed
    // `.album-body` / `.artist-body` subtrees (hidden via CSS class
    // rules). Using a DOM walk rather than `offsetParent` avoids the
    // false-negative for `position:fixed` elements whose offsetParent
    // is null even when they are perfectly visible.
    if (!el) return false;
    let node = el;
    while (node && node !== document.body) {
        if (getComputedStyle(node).display === 'none') return false;
        node = node.parentElement;
    }
    return true;
}

// `_libNavItems` is consulted on every arrow / Enter / Space / Home /
// End / activation press, including during autorepeat. Re-running
// `querySelectorAll` + visibility filtering on every keypress is the
// dominant cost on large libraries (hundreds of nodes × per-keypress
// layout reads), so the result is memoised against a generation
// counter that's bumped only when the underlying DOM actually
// changes shape: render functions and `_toggleHeader` bump
// `_libNavGeneration`. Cache misses fall through to a fresh query.
let _libNavGeneration = 0;
let _libNavItemsCache = { gen: -1, items: [], container: null, mode: null, scope: null };
function _bumpLibNavGeneration() { _libNavGeneration++; }

function _libNavItems() {
    const active = document.querySelector('.screen.active');
    if (!active) return { items: [], container: null, mode: null };
    let tree, grid;
    if (active.id === 'home') {
        tree = document.getElementById('lib-tree');
        grid = document.getElementById('lib-grid');
    } else if (active.id === 'favorites') {
        tree = document.getElementById('fav-tree');
        grid = document.getElementById('fav-grid');
    } else {
        return { items: [], container: null, mode: null };
    }
    const treeMode = tree && !tree.classList.contains('hidden');
    const scope = treeMode ? tree : grid;
    // Cache key includes the active container — switching grid↔tree or
    // home↔favorites must miss even if the generation hasn't ticked.
    if (
        _libNavItemsCache.gen === _libNavGeneration &&
        _libNavItemsCache.scope === scope &&
        scope && document.body.contains(scope)
    ) {
        return {
            items: _libNavItemsCache.items,
            container: _libNavItemsCache.container,
            mode: _libNavItemsCache.mode,
        };
    }
    let items, container, mode;
    if (treeMode) {
        // List mode — include artist headers, album headers, and song
        // rows so arrow nav still works when artists/albums are
        // collapsed (only the headers are visible then). Filter to
        // the currently-displayed nodes so collapsed children don't
        // count as targets the keyboard can land on.
        const all = Array.from(tree.querySelectorAll(
            '.artist-header, .album-header, .song-row[data-play], .song-row[data-library-song][tabindex="0"]'
        ));
        items = all.filter(_isElementVisible);
        container = tree;
        mode = 'list';
    } else {
        items = Array.from((grid || document).querySelectorAll('.song-card[data-play], .song-card[data-library-song][tabindex="0"]'));
        container = grid;
        mode = 'grid';
    }
    _libNavItemsCache = { gen: _libNavGeneration, items, container, mode, scope };
    return { items, container, mode };
}

function _gridColumns(container) {
    // Count columns by grouping the first row of children by their
    // top coordinate. Robust against any grid-template-columns syntax
    // (`repeat(...)`, `auto-fit`, named lines, etc.) where naively
    // splitting `getComputedStyle().gridTemplateColumns` on whitespace
    // would miscount because of spaces inside `repeat(...)` /
    // `minmax(...)`. Falls back to 1 when the container is empty
    // so callers' max(1, ...) clamps stay valid.
    if (!container) return 1;
    const children = Array.from(container.children).filter(
        c => c && c.offsetParent !== null
    );
    if (!children.length) return 1;
    const firstTop = children[0].getBoundingClientRect().top;
    let cols = 0;
    for (const c of children) {
        // Allow ~1px slop for sub-pixel rounding so two children that
        // would visually align still group together.
        if (Math.abs(c.getBoundingClientRect().top - firstTop) < 1.5) cols++;
        else break;
    }
    return Math.max(1, cols);
}

// Tracked separately from `document.activeElement` so the persistent
// `.selected` highlight survives focus drifting elsewhere (clicks
// outside the grid, drawer opening, etc). Also lets us avoid a global
// `querySelectorAll('.selected')` on every arrow press — large
// libraries make that a noticeable hot path.
let _lastLibSelected = null;

// Tracks which list screen launched the player so Esc-from-player
// returns the user to that screen instead of always defaulting to
// the Library (feedBack#126). Reset on every `playSong` call so a
// song launched from a deep-link / plugin screen still gets a sane
// fallback ('home').
let _playerOriginScreen = 'home';
let _settingsOriginScreen = 'home';

// One-shot flag set in `showScreen` when the user enters Home or
// Favorites. Consumed by the very next library render so the
// restored selection scrolls into view exactly once on screen entry
// (player → home, hard reload). Routine re-renders driven by
// search / sort / filter changes leave the user's scroll position
// alone — the highlight still re-applies, but they aren't yanked.
const _libScrollOnNextRender = { home: false, favorites: false };

// localStorage keys for "remember the last selection across reloads
// and after returning from the player". One key per screen so the
// Library and Favorites trees don't fight over the same slot. Only
// song-row / song-card selections are persisted — header selections
// in the tree are ephemeral by design (re-derived from arrow nav).
const _LIB_SELECTED_KEY = 'feedBack.libLastSelected';
const _FAV_SELECTED_KEY = 'feedBack.favLastSelected';
function _selectedKeyForActiveScreen() {
    const active = document.querySelector('.screen.active');
    if (!active) return null;
    if (active.id === 'home') return _LIB_SELECTED_KEY;
    if (active.id === 'favorites') return _FAV_SELECTED_KEY;
    return null;
}
function _persistLibSelection(el) {
    if (!el || !el.dataset) return;
    // Both local entries (data-play) and remote entries (data-library-song,
    // no data-play yet) are persisted so the selection highlight survives a
    // library re-render after sync or provider switch.
    const isLocal = !!el.dataset.play;
    const isRemote = !isLocal && !!el.dataset.librarySong;
    if (!isLocal && !isRemote) return;
    const key = _selectedKeyForActiveScreen();
    if (!key) return;
    // Stored as JSON `{f, a, p, s}`:
    //   f — encoded filename (local entries); drives data-play restore.
    //   a — artist, for future cross-page restore.
    //   p — encoded provider id; prevents cross-provider collisions.
    //   s — encoded song id (remote entries); drives data-library-song restore.
    // Older bare-string and {f,a}/{f,a,p} formats are still tolerated in
    // `_loadPersistedLibSelection`.
    const artist = el.dataset.artist || '';
    const provider = el.dataset.libraryProvider || '';
    // For synced provider entries (data-play + data-library-song both present),
    // persist both f and s so _restoreLibSelection can match the card by either
    // attribute after a post-sync re-render.
    const payload = isLocal
        ? { f: el.dataset.play, a: artist, p: provider, s: el.dataset.librarySong || '' }
        : { f: '', a: artist, p: provider, s: el.dataset.librarySong };
    try {
        localStorage.setItem(key, JSON.stringify(payload));
    } catch { /* private mode / quota */ }
}

function _loadPersistedLibSelection(key) {
    let raw = null;
    try { raw = localStorage.getItem(key); } catch { return null; }
    if (!raw) return null;
    // Tolerate the older bare-string format (just the encoded
    // filename) — older builds wrote that and we'd rather upgrade
    // silently than orphan the user's saved selection.
    if (raw[0] !== '{') return { f: raw, a: '', p: '', s: '' };
    try {
        const o = JSON.parse(raw);
        return (o && typeof o === 'object') ? { f: o.f || '', a: o.a || '', p: o.p || '', s: o.s || '' } : null;
    } catch { return null; }
}


function _setLibSelection(el, { focus = true } = {}) {
    if (!el) return;
    // Only the previously-tracked element needs its `.selected` class
    // cleared. classList.remove on an element that no longer carries
    // the class is a no-op, so a stale `_lastLibSelected` from a
    // re-render is harmless. Avoids the global `querySelectorAll`
    // pass that the earlier implementation ran on every keypress.
    if (_lastLibSelected && _lastLibSelected !== el) {
        _lastLibSelected.classList.remove('selected');
    }
    el.classList.add('selected');
    _lastLibSelected = el;
    // Save song selections to localStorage so a reload (or returning
    // from the player) can restore the highlight. Headers don't get
    // persisted — they don't carry a stable id and the tree's auto-
    // open heuristic re-derives them on each render anyway.
    _persistLibSelection(el);
    if (focus) {
        // `preventScroll: true` skips the browser's native focus-scroll,
        // then we run a single `scrollIntoView` so we don't double-jank
        // when the element is partially in view. The browser's default
        // focus scroll uses `block: 'nearest'` too but isn't smoothable
        // and can interact poorly with sticky headers.
        el.focus({ preventScroll: true });
    }
    _scrollSelectionIntoView(el);
}

// Scroll the selected element to keep it inside a margin from the
// viewport edges. Plain `scrollIntoView({block:'nearest'})` only
// reacts when the element is fully off-screen, so during arrow nav
// the selection drifts to the edge and stays partially visible
// until it falls off — feels laggy. Centering when the row enters
// the buffer zone keeps it comfortably on-screen as the user holds
// the arrow keys.
const _SCROLL_EDGE_MARGIN = 96;
function _scrollSelectionIntoView(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (r.top < _SCROLL_EDGE_MARGIN || r.bottom > vh - _SCROLL_EDGE_MARGIN) {
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
}

function _restoreLibSelection(scopeEl, screen, { scroll = true } = {}) {
    // Re-apply the persistent `.selected` class to whichever song
    // matches the saved filename. For the tree we also walk up and
    // open every collapsed ancestor so the restored row is actually
    // visible — the user shouldn't have to hunt for their place
    // inside a collapsed artist node.
    if (!scopeEl) return null;
    const key = screen === 'favorites' ? _FAV_SELECTED_KEY : _LIB_SELECTED_KEY;
    const saved = _loadPersistedLibSelection(key);
    if (!saved || (!saved.f && !saved.s)) return null;
    // Match by dataset values — both stored and DOM values are in the
    // encoded form, so no decoding is needed. Avoid interpolating persisted
    // data into CSS selectors so malformed localStorage can't make
    // querySelector throw and break rendering.
    //
    // Local entries: match data-play (f) + data-library-provider (p) when p
    // is present to avoid cross-provider collisions on the same filename.
    // Remote entries: match data-library-song (s) + data-library-provider (p).
    // When f is present but no data-play card matches (e.g. the file has not
    // been downloaded on this load), fall back to the s (provider song-id) so
    // a previously-synced remote selection can still be restored.
    let el = null;
    if (saved.f) {
        const candidates = scopeEl.querySelectorAll('.song-card[data-play], .song-row[data-play]');
        el = Array.from(candidates).find((node) => {
            if (node.dataset.play !== saved.f) return false;
            if (saved.p && node.dataset.libraryProvider !== saved.p) return false;
            return true;
        });
    }
    if (!el && saved.s) {
        const candidates = scopeEl.querySelectorAll('.song-card[data-library-song], .song-row[data-library-song]');
        el = Array.from(candidates).find((node) => {
            if (node.dataset.librarySong !== saved.s) return false;
            if (saved.p && node.dataset.libraryProvider !== saved.p) return false;
            return true;
        });
    }
    if (!el) return null;
    // Open every collapsed ancestor in the tree so the restored row
    // is on-screen; harmless on the grid since cards have no such
    // ancestors. Sync `aria-expanded` on the matching header inside
    // each ancestor too — bypassing `_toggleHeader` here would leave
    // assistive tech reporting "collapsed" while the visual is open.
    let n = el.parentElement;
    while (n && n !== scopeEl) {
        if (n.classList.contains('artist-row') || n.classList.contains('album-group')) {
            n.classList.add('open');
            const header = Array.from(n.children).find(c => c.classList.contains('artist-header') || c.classList.contains('album-header'));
            if (header) header.setAttribute('aria-expanded', 'true');
        }
        n = n.parentElement;
    }
    if (_lastLibSelected && _lastLibSelected !== el) {
        _lastLibSelected.classList.remove('selected');
    }
    el.classList.add('selected');
    _lastLibSelected = el;
    // Center the restored element in the viewport so the user's eye
    // lands on it instead of having to scan up from the bottom edge.
    // `block: 'center'` is forgiving of items already on-screen — the
    // browser only scrolls when needed to bring the requested
    // alignment into view.
    // Skip when the caller opts out (e.g. during search/filter/sort
    // re-renders, where the user's scroll position should be left
    // alone and only the `.selected` class is re-applied).
    if (scroll) {
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
    return el;
}

function _moveSelectionInItems(items, deltaIdx) {
    // Items are passed in by the caller so we don't re-query the DOM
    // twice per keypress (handler queries `_libNavItems`, then we'd
    // query it again).
    if (!items.length) return false;
    const current = document.activeElement && items.includes(document.activeElement)
        ? document.activeElement
        : (_lastLibSelected && items.includes(_lastLibSelected) ? _lastLibSelected : null);
    let idx = current ? items.indexOf(current) : -1;
    let next;
    if (idx === -1) {
        // No current selection — first arrow lands on the first item
        // regardless of direction. Saves a press.
        next = items[0];
    } else {
        next = items[Math.max(0, Math.min(items.length - 1, idx + deltaIdx))];
    }
    _setLibSelection(next);
    return true;
}

function _isInsideInteractiveControl(el) {
    // Bail when the user is interacting with anything that has its
    // own keyboard semantics — form controls (checkbox / select /
    // button) consume arrow keys for their own behavior, and the
    // filters drawer is a focus trap of those. Without this guard the
    // library's arrow nav would steal arrow presses from a focused
    // tuning checkbox or sort dropdown.
    if (!el) return false;
    const tag = el.tagName;
    if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(tag)) return true;
    if (el.isContentEditable) return true;
    if (el.closest && el.closest('#lib-filter-drawer, [role="dialog"], #edit-modal')) return true;
    return false;
}


function _isSpaceKey(e) {
    return e.key === ' ' || e.key === 'Spacebar';
}

function _sectionPracticeBarContains(el) {
    if (!el) return false;
    const bar = document.getElementById('section-practice-bar');
    return !!(bar && bar.contains(el));
}

function _shortcutDispatchBlocked(e) {
    if (_isTextInput(e.target)) return true;
    // Space in Section Practice bar should pause/resume, not toggle checkboxes/buttons.
    if (_isSpaceKey(e) && _sectionPracticeBarContains(e.target)) return false;
    // While the Section Practice popover is open, Esc just closes it (handled by
    // the popover's own keydown listener) — suppress the player-scope
    // "back to library" Esc so the user doesn't get bounced out of the player.
    if (e.key === 'Escape' && _sectionPracticePopoverOpen()) return true;
    // Space on the player screen should always play/pause, even if focus is on a
    // sidebar nav link, player rail button, popover control, or any other
    // interactive element — the shortcut dispatcher calls preventDefault so the
    // focused element won't also activate. Two exceptions keep native Space:
    // text inputs (already exempted above), and focus inside a true modal
    // dialog (role="dialog" aria-modal="true", or a .feedBack-modal overlay)
    // layered over the player — a modal traps interaction, so Space must reach
    // its focused control (e.g. the Close button) rather than toggle playback
    // behind it. Non-modal player popovers/toasts (loop A/B, arrangement pin,
    // role="dialog" aria-modal="false") are not modals and stay covered.
    if (_isSpaceKey(e) && _getCurrentContext().isPlayer &&
        !(e.target && e.target.closest &&
          e.target.closest('[role="dialog"][aria-modal="true"], .feedBack-modal'))) {
        return false;
    }
    // Escape is the universal "back" action and must fire like Space above even
    // when a transport/rail control <button> holds keyboard focus after a click
    // — otherwise a focused control swallows Esc and the user can't leave the
    // song until they click empty canvas (feedBack — "Escape in song not
    // consistent"). It applies on the player (exit the song) AND settings
    // (return to the previous screen), both of which register an Escape=Back
    // shortcut. The earlier guards still win: text inputs are exempted at the
    // top (Esc there clears/blurs the field), and the Section Practice popover
    // already claimed Esc above. A true modal layered over the screen still
    // traps Esc — the modal-overlay check keeps Esc closing the modal rather
    // than ejecting past it to the screen behind.
    if (e.key === 'Escape') {
        const ctx = _getCurrentContext();
        if ((ctx.isPlayer || ctx.isSettings) &&
            !(e.target && e.target.closest &&
              e.target.closest('[role="dialog"][aria-modal="true"], .feedBack-modal'))) {
            return false;
        }
    }
    return _isInsideInteractiveControl(e.target);
}

function _handleLibArrowNav(e) {
    // Space (' ') is the standard activation key for focusable
    // elements alongside Enter — without it, a screen-reader user
    // hitting Space on a focused card would just scroll the page
    // instead of activating it. We treat Space identically to Enter
    // inside this handler.
    const isActivate = e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar';
    if (!isActivate &&
        !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
        return false;
    }
    if (_isInsideInteractiveControl(document.activeElement)) return false;
    const { items, container, mode } = _libNavItems();
    if (!items.length) return false;

    const currentTarget = (document.activeElement && items.includes(document.activeElement))
        ? document.activeElement
        : (_lastLibSelected && items.includes(_lastLibSelected) ? _lastLibSelected : null);

    if (isActivate) {
        if (!currentTarget) return false;
        e.preventDefault();
        // Sync persistent selection before activating so Tab-then-Enter
        // (no prior arrow nav or mouse click) still lights up the `.selected`
        // ring and updates `_lastLibSelected`/localStorage — consistent with
        // the click delegate at the bottom of this file.
        _setLibSelection(currentTarget, { focus: false });
        if (currentTarget.classList.contains('song-row') ||
            currentTarget.classList.contains('song-card')) {
            if (currentTarget.dataset.librarySong && !currentTarget.dataset.play) {
                const providerId = decodeURIComponent(currentTarget.dataset.libraryProvider || '');
                if (!_providerSupports(providerId, 'song.sync')) return true;
                syncLibrarySong(
                    providerId,
                    decodeURIComponent(currentTarget.dataset.librarySong || ''),
                    { playWhenReady: true },
                );
                return true;
            }
            // Song row OR card → play it. Pass `dataset.play` raw to
            // match the click delegate; `playSong` handles decoding
            // internally so decoding here would double-decode and
            // throw `URIError` on filenames containing `%`.
            playSong(currentTarget.dataset.play, undefined, { bridge: false });
        } else if (currentTarget.classList.contains('artist-header') ||
                   currentTarget.classList.contains('album-header')) {
            // Header row → toggle the parent open/closed and re-derive
            // visible items so the next arrow press lands correctly.
            // `_toggleHeader` keeps `aria-expanded` in sync for
            // assistive tech.
            _toggleHeader(currentTarget);
            // Keep keyboard focus on the header we just toggled —
            // browsers sometimes drop focus to body when the
            // surrounding subtree changes display.
            currentTarget.focus({ preventScroll: true });
        }
        return true;
    }

    if (e.key === 'Home') { e.preventDefault(); _setLibSelection(items[0]); return true; }
    if (e.key === 'End')  { e.preventDefault(); _setLibSelection(items[items.length - 1]); return true; }

    if (mode === 'list') {
        if (e.key === 'ArrowDown') { e.preventDefault(); _moveSelectionInItems(items, 1); return true; }
        if (e.key === 'ArrowUp')   { e.preventDefault(); _moveSelectionInItems(items, -1); return true; }
        // Right/Left expand and collapse the artist/album under focus,
        // file-manager style. With nothing selected yet, both keys
        // initialize selection on the first visible item (matches
        // Up/Down behavior in `_moveSelectionInItems`) so the first
        // press doesn't fall through to native scroll.
        if (!currentTarget && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
            e.preventDefault();
            _setLibSelection(items[0]);
            return true;
        }
        if (e.key === 'ArrowRight' && currentTarget) {
            const parent = (currentTarget.classList.contains('artist-header') ||
                            currentTarget.classList.contains('album-header'))
                ? currentTarget.parentElement : null;
            if (parent && !parent.classList.contains('open')) {
                e.preventDefault();
                // Use the shared toggle path so aria-expanded stays
                // synced with the visual state for screen readers.
                _toggleHeader(currentTarget);
                currentTarget.focus({ preventScroll: true });
                return true;
            }
            // Already open — step to the next visible item (which is
            // the first child of this header).
            e.preventDefault();
            _moveSelectionInItems(items, 1);
            return true;
        }
        if (e.key === 'ArrowLeft' && currentTarget) {
            // If on an open header, collapse it. If on a song row or
            // closed header, jump to the nearest enclosing header.
            const isHeader = currentTarget.classList.contains('artist-header') ||
                             currentTarget.classList.contains('album-header');
            const headerParent = isHeader ? currentTarget.parentElement : null;
            if (headerParent && headerParent.classList.contains('open')) {
                e.preventDefault();
                _toggleHeader(currentTarget);
                currentTarget.focus({ preventScroll: true });
                return true;
            }
            // Walk up to the nearest .album-header / .artist-header
            // ancestor's sibling header. Closest album-group → its
            // header; otherwise closest artist-row → its header.
            const albumGroup = currentTarget.closest('.album-group');
            if (albumGroup && albumGroup.contains(currentTarget) &&
                !currentTarget.classList.contains('album-header')) {
                e.preventDefault();
                _setLibSelection(albumGroup.querySelector('.album-header'));
                return true;
            }
            const artistRow = currentTarget.closest('.artist-row');
            if (artistRow && !currentTarget.classList.contains('artist-header')) {
                e.preventDefault();
                _setLibSelection(artistRow.querySelector('.artist-header'));
                return true;
            }
            return false;
        }
        return false;
    }
    // Grid mode: 2D nav. Columns are read from the live CSS grid so
    // we follow the responsive breakpoints automatically.
    const cols = _gridColumns(container);
    if (e.key === 'ArrowRight') { e.preventDefault(); _moveSelectionInItems(items, 1); return true; }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); _moveSelectionInItems(items, -1); return true; }
    if (e.key === 'ArrowDown')  { e.preventDefault(); _moveSelectionInItems(items, cols); return true; }
    if (e.key === 'ArrowUp')    { e.preventDefault(); _moveSelectionInItems(items, -cols); return true; }
    return false;
}

// Focus trap: keep Tab / Shift+Tab cycling inside `modal` so focus
// can't escape to the content underneath while the overlay is open.
// Call this once after the modal is in the DOM and initial focus is set.
function _trapFocusInModal(modal) {
    const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    modal.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        const els = Array.from(modal.querySelectorAll(FOCUSABLE)).filter(el => {
            if (!_isElementVisible(el)) return false;
            if (getComputedStyle(el).visibility === 'hidden') return false;
            if (el.disabled) return false;
            return true;
        });
        if (!els.length) return;
        const first = els[0];
        const last = els[els.length - 1];
        if (e.shiftKey) {
            if (document.activeElement === first) { e.preventDefault(); last.focus(); }
        } else {
            if (document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    });
}

// Styled async confirm dialog. Returns a Promise<boolean>. For destructive
// prompts pass `danger: true` — confirm button turns red and Cancel gets
// initial focus so an accidental Enter won't fire the action. `body` is
// inserted as HTML so callers can use formatting; callers are responsible
// for escaping any user-supplied content in it (use _escAttr).
function _confirmDialog({ title, body = '', confirmText = 'Confirm', cancelText = 'Cancel', danger = false } = {}) {
    return new Promise((resolve) => {
        const previouslyFocused = document.activeElement;
        const modal = document.createElement('div');
        modal.className = 'feedBack-modal fixed inset-0 z-[250] flex items-center justify-center bg-black/70 backdrop-blur-sm';
        modal.setAttribute('role', 'alertdialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-label', title || 'Confirm');
        const confirmClass = danger
            ? 'flex-1 bg-red-600 hover:bg-red-500 px-4 py-2 rounded-xl text-sm font-semibold text-white transition focus:outline-none focus:ring-2 focus:ring-red-400/60'
            : 'flex-1 bg-accent hover:bg-accent-light px-4 py-2 rounded-xl text-sm font-semibold text-white transition focus:outline-none focus:ring-2 focus:ring-accent/60';
        modal.innerHTML = `
            <div class="bg-dark-700 border border-gray-700 rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl">
                <h3 class="text-lg font-bold text-white mb-3">${_escAttr(title || '')}</h3>
                <div class="mb-5">${body}</div>
                <div class="flex gap-3">
                    <button type="button" data-confirm class="${confirmClass}">${_escAttr(confirmText)}</button>
                    <button type="button" data-cancel class="px-4 py-2 bg-dark-600 hover:bg-dark-500 rounded-xl text-sm text-gray-300 transition focus:outline-none focus:ring-2 focus:ring-gray-500/40">${_escAttr(cancelText)}</button>
                </div>
            </div>`;
        document.body.appendChild(modal);

        function finish(result) {
            modal.remove();
            document.removeEventListener('keydown', onKey, true);
            if (previouslyFocused && document.body.contains(previouslyFocused)) {
                try { previouslyFocused.focus({ preventScroll: true }); } catch {}
            }
            resolve(result);
        }
        function onKey(e) {
            if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish(false); }
            else if (e.key === 'Enter' && document.activeElement === modal.querySelector('[data-confirm]')) {
                e.preventDefault(); finish(true);
            }
        }
        modal.addEventListener('click', (e) => {
            if (e.target === modal) finish(false);
            else if (e.target.closest('[data-confirm]')) finish(true);
            else if (e.target.closest('[data-cancel]')) finish(false);
        });
        document.addEventListener('keydown', onKey, true);
        _trapFocusInModal(modal);
        // Focus Cancel by default for destructive prompts so an accidental
        // Enter / Space won't fire the dangerous action; otherwise focus
        // the confirm button so Enter accepts.
        const focusTarget = modal.querySelector(danger ? '[data-cancel]' : '[data-confirm]');
        if (focusTarget) focusTarget.focus({ preventScroll: true });
    });
}

// Shortcut cheat-sheet overlay. Opens on `?` (Shift+/), closes on
// Esc (handled by the generic modal close path) or on backdrop /
// close-button click. The list mirrors the canonical shortcut table
// in this file's keydown handler — when a shortcut changes here, the
// table below should change too. We keep it inline rather than
// fetching a separate file so the cheat sheet can never disagree
// with the version of app.js the user actually loaded.
function _openShortcutsModal() {
    if (document.getElementById('shortcuts-modal')) return;

    function _isTreeMode() {
        // Check if we're in tree view (not grid) on the active library screen
        const screen = document.querySelector('.screen.active');
        if (!screen) return false;
        const tree = screen.querySelector('#lib-tree,#fav-tree');
        return tree && !tree.classList.contains('hidden');
    }

    const ctx = _getCurrentContext();

    // Library shortcuts that are handled by the navigation system (not in registry)
    const navShortcuts = [
        { keys: '↑ ↓', desc: 'Move selection' },
        { keys: '→', desc: 'Step in', condition: _isTreeMode },
        { keys: '←', desc: 'Step out', condition: _isTreeMode },
        { keys: 'Home / End', desc: 'Jump to first / last item' },
        { keys: 'Enter / Space', desc: 'Activate selection (play song / toggle header)' },
    ];

    // Filter out items whose condition returns false
    const filterNavItems = (items) => items.filter(item => !item.condition || item.condition());

    // Format a shortcut entry for display, including modifier prefixes
    const formatShortcut = (s) => {
        const mods = s.modifiers || {};
        let label = '';
        if (mods.ctrl) label += 'Ctrl+';
        if (mods.alt) label += 'Alt+';
        if (mods.shift) label += 'Shift+';
        if (mods.meta) label += 'Meta+';
        return label + s.key;
    };

    // Get shortcuts from active panel by scope
    const getPanelShortcuts = (panel, scope) => {
        const shortcuts = [];
        for (const [key, s] of panel.shortcuts) {
            if (s.scope === scope) {
                shortcuts.push({ keys: formatShortcut(s), desc: s.description });
            }
        }
        return shortcuts;
    };

    const activePanel = _panels.get(_activePanel);
    const defaultPanel = _panels.get('default');

    // Merge shortcuts from both active and default panel for display
    const mergeShortcuts = (scope) => {
        const result = [];
        if (activePanel) result.push(...getPanelShortcuts(activePanel, scope));
        if (defaultPanel && defaultPanel !== activePanel) result.push(...getPanelShortcuts(defaultPanel, scope));
        return result;
    };

    const playerShortcuts = mergeShortcuts('player');
    const globalShortcuts = mergeShortcuts('global');
    const libraryShortcuts = mergeShortcuts('library');

    // Get plugin shortcuts for current plugin screen
    const pluginShortcuts = [];
    if (ctx.isPlugin && activePanel) {
        for (const [key, s] of activePanel.shortcuts) {
            if (s.scope.startsWith('plugin-') && s.scope === ctx.screen) {
                pluginShortcuts.push({ keys: formatShortcut(s), desc: s.description });
            }
        }
    }

    // Get shortcuts from other panels (if multiple panels exist)
    const otherPanelShortcuts = [];
    if (_panels.size > 1) {
        for (const [panelId, panel] of _panels) {
            if (panelId === _activePanel) continue;
            for (const [key, s] of panel.shortcuts) {
                otherPanelShortcuts.push({ keys: formatShortcut(s), desc: s.description, panel: panelId });
            }
        }
    }

    // Build sections based on current context
    const sections = [];
    if (ctx.isSettings) {
        sections.push({ heading: 'Settings', items: mergeShortcuts('settings') });
    } else if (ctx.isLibrary) {
        sections.push({ heading: 'Library', items: [
            ...filterNavItems(navShortcuts),
            ...libraryShortcuts,
            { keys: 'Esc', desc: 'Clear search' }
        ]});
    }
    if (ctx.isPlayer) {
        sections.push({ heading: 'Player', items: playerShortcuts });
    }
    if (!ctx.isSettings && globalShortcuts.length > 0) {
        sections.push({ heading: 'Global', items: globalShortcuts });
    }
    if (pluginShortcuts.length > 0) {
        sections.push({ heading: 'Current Plugin', items: pluginShortcuts });
    }
    if (otherPanelShortcuts.length > 0) {
        // Group other panel shortcuts by panel
        const byPanel = new Map();
        for (const item of otherPanelShortcuts) {
            if (!byPanel.has(item.panel)) {
                byPanel.set(item.panel, []);
            }
            byPanel.get(item.panel).push(item);
        }
        for (const [panelId, items] of byPanel) {
            sections.push({ heading: `Panel ${panelId}`, items });
        }
    }

    const modal = document.createElement('div');
    modal.id = 'shortcuts-modal';
    modal.className = 'feedBack-modal fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Keyboard shortcuts');
    // Record the element that triggered the modal so Esc / close can
    // return focus to the correct entry even if _lastLibSelected drifts.
    // Scope to the active screen so a stale _lastLibSelected from a
    // different screen (e.g. Library vs Favorites) doesn't receive focus.
    const _scModal = document.querySelector('.screen.active');
    modal._opener = (_lastLibSelected && document.body.contains(_lastLibSelected)
        && _scModal && _scModal.contains(_lastLibSelected))
        ? _lastLibSelected : null;

    const sectionsHtml = sections.map(section => {
        const itemsHtml = section.items.map(({ keys, desc }) => `
            <div class="flex items-baseline justify-between gap-4 py-1.5">
                <span class="text-sm text-gray-300">${esc(desc)}</span>
                <kbd class="text-xs font-mono px-2 py-0.5 rounded bg-dark-600 border border-gray-700 text-gray-200 whitespace-nowrap">${esc(keys)}</kbd>
            </div>
        `).join('');
        return `
            <section class="mb-4 last:mb-0">
                <h4 class="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">${esc(section.heading)}</h4>
                ${itemsHtml}
            </section>
        `;
    }).join('');

    modal.innerHTML = `
        <div class="bg-dark-700 border border-gray-700 rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl">
            <div class="flex items-center justify-between mb-4">
                <h3 class="text-lg font-bold text-white">Keyboard shortcuts</h3>
                <button type="button" data-shortcuts-close
                        class="text-gray-500 hover:text-white transition flex items-center gap-1.5" aria-label="Close shortcuts">
                    <span class="text-xs text-gray-600">Esc</span>
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                </button>
            </div>
            ${sectionsHtml}
        </div>
    `;

    // Click outside the inner panel (i.e. on the backdrop) closes the
    // modal — matches the conventional dialog UX.
    modal.addEventListener('click', (ev) => {
        if (ev.target === modal || ev.target.closest('[data-shortcuts-close]')) {
            const opener = modal._opener;
            modal.remove();
            const focusTarget = (opener && document.body.contains(opener)) ? opener
                : (_lastLibSelected && document.body.contains(_lastLibSelected) ? _lastLibSelected : null);
            if (focusTarget) focusTarget.focus({ preventScroll: true });
        }
    });

    document.body.appendChild(modal);
    // Move focus into the dialog so background shortcuts (and arrow
    // nav) can't fire on the underlying library entry while the
    // overlay is open. Close button is the safe default — there's no
    // primary input to focus on a read-only cheat sheet.
    const closeBtn = modal.querySelector('[data-shortcuts-close]');
    if (closeBtn) closeBtn.focus({ preventScroll: true });
    // Trap Tab / Shift+Tab inside the modal so focus can't escape to
    // the library content underneath while the overlay is open.
    _trapFocusInModal(modal);
}

document.addEventListener('keydown', (e) => {
    // Modifier-key combos belong to the browser / OS shortcuts; never
    // intercept those.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (_handleLibArrowNav(e)) return;

    // `?` (Shift+/) opens the keyboard-shortcuts cheat sheet. Some
    // Linux/Electron stacks report Shift+/ as key='/' with code='Slash',
    // so check the help shape before treating plain '/' as search.
    if (_isShortcutHelpKey(e)) {
        if (_isShortcutHelpSuppressedTarget(e.target || document.activeElement)) return;
        e.preventDefault();
        // Stop other keydown listeners on document (notably the shortcut
        // registry below) from also consuming this event — otherwise a
        // Linux/Electron Shift+Slash reported as key='/' opens help here and
        // then the registry's plain `/` library-search shortcut focuses
        // #lib-filter behind the modal. (Copilot review on #602.)
        e.stopImmediatePropagation();
        _openShortcutsModal();
        return;
    }

    if (e.key === '/') {
        if (_isTextInput(document.activeElement)) return;
        // Also bail when focus is inside the filter drawer, a dialog, or
        // any other interactive region — those contexts have their own
        // keyboard semantics and shouldn't be hijacked by the search
        // shortcut (e.g. a focused checkbox inside the filters drawer).
        if (_isInsideInteractiveControl(document.activeElement)) return;
        const search = _activeSearchInput();
        if (!search) return;
        e.preventDefault();  // suppress the literal '/' the input would receive
        search.focus();
        // Move caret to end without mutating .value — round-tripping
        // the value resets the browser's undo stack and can fire
        // unexpected input events on some engines. setSelectionRange
        // is the no-side-effects path.
        try {
            const len = search.value.length;
            search.setSelectionRange(len, len);
        } catch {
            // Some input types (search/email/tel) don't support
            // selection APIs in older browsers; the focus alone is
            // still useful, just no caret-end guarantee.
        }
        return;
    }

    // Single-letter shortcuts that act on the focused / selected
    // library entry — works on both grid cards and tree rows. Each
    // dispatches to a button class that the entry markup already
    // exposes, so plugins can keep owning the actual behavior:
    //   f → .fav-btn              (favorite heart toggle)
    //   e → .edit-btn             (edit metadata modal)
    // No-op when no entry is currently focused / selected, when the
    // entry doesn't expose the requested button, or when the button is disabled.
    // Bails on text input / drawer focus so single-letter typing in
    // inputs still works.
    const entryShortcut = { f: 'button.fav-btn', e: 'button.edit-btn' }[e.key.toLowerCase()];
    if (entryShortcut) {
        if (_isInsideInteractiveControl(document.activeElement)) return;
        const ae = document.activeElement;
        const activeScreen = document.querySelector('.screen.active');
        const isEntry = el => el && el.classList && (el.classList.contains('song-card') || el.classList.contains('song-row'));
        // Scope both candidates to the active screen so that a stale
        // _lastLibSelected from Library doesn't fire when the user is
        // on Favorites (or vice-versa), and so pressing f/e/c on a
        // hidden screen can't accidentally persist that filename into
        // the current screen's localStorage key.
        const inActiveScreen = el => activeScreen && activeScreen.contains(el);
        const target = (isEntry(ae) && inActiveScreen(ae)) ? ae
            : (isEntry(_lastLibSelected) && inActiveScreen(_lastLibSelected) ? _lastLibSelected : null);
        if (!target) return;
        const btn = target.querySelector(entryShortcut);
        if (!btn || btn.disabled) return;
        e.preventDefault();
        // Sync the persistent selection to the acted-on entry so that
        // Esc-to-close-modal returns focus to the correct element and
        // the `.selected` highlight stays consistent with the action.
        _setLibSelection(target, { focus: false });
        btn.click();
        return;
    }

    if (e.key === 'Escape') {
        // Modal-first: close the topmost open modal (edit-metadata,
        // shortcuts cheat sheet, future modals) so Esc dismisses
        // from anywhere — including when keyboard focus is inside
        // a form field within the modal. Restores focus to the
        // element that opened the modal (tracked in modal._opener)
        // so arrow nav resumes without an extra Tab; falls back to
        // _lastLibSelected when the opener is no longer in the DOM.
        const modals = document.querySelectorAll('[role="dialog"][aria-modal="true"].feedBack-modal');
        if (modals.length) {
            e.preventDefault();
            e.stopImmediatePropagation();
            const modal = modals[modals.length - 1];
            const opener = modal._opener;
            modal.remove();
            const focusTarget = (opener && document.body.contains(opener)) ? opener
                : (_lastLibSelected && document.body.contains(_lastLibSelected) ? _lastLibSelected : null);
            if (focusTarget) focusTarget.focus({ preventScroll: true });
            return;
        }
        // Esc while typing in either search box clears + blurs. Other Esc
        // semantics (drawer close, screen back) are handled elsewhere; we
        // only act when a search box is the focused element.
        const ae = document.activeElement;
        if (ae && (ae.id === 'lib-filter' || ae.id === 'fav-filter')) {
            if (ae.value) {
                ae.value = '';
                ae.dispatchEvent(new Event('input', { bubbles: true }));
            }
            ae.blur();
        }
    }
});

// ── Screen Navigation ─────────────────────────────────────────────────────
async function showScreen(id) {
    // Capture the previous screen before changing active classes
    const prevScreenId = document.querySelector('.screen.active')?.id;
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    // Mark the next render as a screen-entry so it scrolls the
    // restored selection into view exactly once. Routine renders
    // (search / sort / filter typing) won't have this flag set and
    // so won't yank the viewport. Also bump the nav-items
    // generation so the next keypress doesn't reuse a cache built
    // against a now-hidden screen's container.
    _bumpLibNavGeneration();
    if (id === 'home') {
        _libScrollOnNextRender.home = true;
        const beforeProviderId = _activeLibraryProviderId();
        await loadLibraryProviders({ restoreSaved: true });
        if (_activeLibraryProviderId() !== beforeProviderId) {
            _resetLibraryProviderViewState();
        } else {
            _libEpoch++;
            currentPage = 0;
            _treeStats = null;
            stopInfiniteScroll();
        }
        loadLibrary(0);
    }
    if (id === 'favorites') { _libScrollOnNextRender.favorites = true; loadFavorites(); }
    if (id === 'settings') {
        // Record where we came from so Esc can go back. The player screen
        // is torn down by the `id !== 'player'` branch below, so
        // re-entering it via showScreen() would land on a dead screen —
        // fall back to the player's own origin (or 'home') instead.
        if (prevScreenId && prevScreenId !== 'settings') {
            _settingsOriginScreen = prevScreenId === 'player'
                ? (_playerOriginScreen || 'home')
                : prevScreenId;
        }
        loadSettings();
    }
    if (id !== 'player') {
        const audio = document.getElementById('audio');
        const stopTime = _audioTime();
        const hadPlayableSong = !!audio.src || !!window._juceAudioUrl || isPlaying;
        // Snapshot where we were so leaving the player — especially by accident
        // — is recoverable instead of dumping the user back at bar 1 next time.
        // Must run BEFORE highway.stop()/audio unload, while getSongInfo() and
        // the position (stopTime) are still live.
        if (hadPlayableSong) _snapshotResumeSession(stopTime);
        highway.stop();
        // Cancel any queued seeks, in-flight shim closures, AND active
        // count-in timers before stopping playback so none of these paths
        // can mutate the torn-down session (mirrors the same triple reset
        // in playSong()).
        _cancelCountIn();
        _resetJuceAudioShimChain();
        _resetAudioSeekState();
        if (window._juceMode) {
            // HTML5 emits 'pause' via the media-element listener below;
            // JUCE doesn't, so plugins would stay stuck in "playing".
            // Snapshot the canonical payload BEFORE stop() resets _pos
            // to 0, then emit AFTER stop completes. Mirrors the HTML5
            // pause contract via _songEventPayload (audioT/chartT/perfNow).
            const payload = _songEventPayload();
            const wasPlaying = isPlaying;
            await jucePlayer.stop().catch(() => {});
            if (wasPlaying && window.feedBack) {
                window.feedBack.isPlaying = false;
                window.feedBack.emit('song:pause', payload);
            }
            window._juceMode = false;
            window._juceAudioUrl = null;
        }
        if (hadPlayableSong) window.feedBack.emit('song:stop', { time: stopTime || 0, screen: id });
        audio.pause();
        audio.src = '';
        window._currentSongAudio = null;
        // Reloading any song later should get a fresh JUCE routing attempt.
        window._clearJuceRerouteMemo?.();
        isPlaying = false;
        setPlayButtonState(false);
    }
    window.scrollTo(0, 0);
    if (window.feedBack) window.feedBack.emit('screen:changed', { id });
}

// ── Library ──────────────────────────────────────────────────────────────

// Persist the view toggle (grid vs tree), sort selection, and format
// filter across reloads. Stored as separate keys (rather than one
// blob) so future controls can opt in independently and a corrupted
// single value doesn't wipe the rest. Validation lives at the read
// site — we coerce unknown values back to safe defaults rather than
// trusting whatever happens to be in localStorage.
const _LIB_VIEW_KEY = 'feedBack.libView';
const _LIB_SORT_KEY = 'feedBack.libSort';
const _LIB_FORMAT_KEY = 'feedBack.libFormat';
const _LIB_PROVIDER_KEY = 'feedBack.libProvider';
const _LIB_VIEW_VALUES = new Set(['grid', 'tree', 'folder']);
const _LIB_SORT_VALUES = new Set([
    'artist', 'artist-desc', 'title', 'title-desc',
    'recent', 'year-desc', 'year', 'tuning',
    'difficulty', 'difficulty-desc',
]);
const _LIB_FORMAT_VALUES = new Set(['', 'sloppak', 'loose']);
// Tree-view expand/collapse persistence. Three states per tree:
//   '1'  → user asked to expand all
//   '0'  → user asked to collapse all
//   null → no explicit choice; renderTreeInto's existing heuristic
//          (auto-open when search active or few artists) wins
//
// Library and Favorites are separate trees with separate
// Expand/Collapse buttons, so each gets its own key — toggling one
// must not flip the other's persisted state.
const _LIB_TREE_EXPAND_KEY = 'feedBack.libTreeExpand';
const _FAV_TREE_EXPAND_KEY = 'feedBack.favTreeExpand';
const _LIB_TREE_EXPAND_VALUES = new Set(['1', '0']);

function _readPersistedChoice(key, allowed, fallback) {
    try {
        const v = localStorage.getItem(key);
        return v !== null && allowed.has(v) ? v : fallback;
    } catch {
        return fallback;
    }
}
function _writePersistedChoice(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode / quota */ }
}

function _libraryProviderApi() {
    const api = window.feedBack && window.feedBack.libraryProviders;
    return api && typeof api === 'object' ? api : null;
}

function _libraryProviderSnapshot() {
    const api = _libraryProviderApi();
    if (api && typeof api.snapshot === 'function') return api.snapshot();
    return { available: false, current: 'local', providers: [{ id: 'local', label: 'My Library', kind: 'local', capabilities: ['library.read', 'art.read', 'song.play'], default: true }] };
}

function _providerById(providerId) {
    const api = _libraryProviderApi();
    if (api && typeof api.providerById === 'function') return api.providerById(providerId);
    return (_libraryProviderSnapshot().providers || []).find(provider => provider.id === providerId) || null;
}

function _activeLibraryProvider() {
    const api = _libraryProviderApi();
    if (api && typeof api.activeProvider === 'function') return api.activeProvider();
    const snapshot = _libraryProviderSnapshot();
    return _providerById(snapshot.current) || _providerById('local') || (snapshot.providers || [])[0];
}

function _activeLibraryProviderId() {
    const api = _libraryProviderApi();
    if (api && typeof api.activeProviderId === 'function') return api.activeProviderId();
    return (_activeLibraryProvider() || {}).id || 'local';
}

function _isLocalLibraryProvider(providerId) {
    const api = _libraryProviderApi();
    if (api && typeof api.isLocal === 'function') return api.isLocal(providerId);
    const provider = _providerById(providerId);
    return providerId === 'local' || (provider && provider.kind === 'local');
}

function _providerSupports(providerId, capability) {
    const api = _libraryProviderApi();
    if (api && typeof api.supports === 'function') return api.supports(providerId, capability);
    const provider = _providerById(providerId);
    return !!provider && Array.isArray(provider.capabilities) && provider.capabilities.includes(capability);
}

function _applyLibraryProviderToParams(params) {
    params.set('provider', _activeLibraryProviderId());
    return params;
}

function _resetLibraryProviderViewState() {
    _libEpoch++;
    currentPage = 0;
    _treePage = 0;
    _treeStats = null;
    _tuningNames = null;
    stopInfiniteScroll();
}

function _renderLibraryProviderSelector() {
    const select = document.getElementById('lib-provider');
    const title = document.getElementById('lib-title');
    const activeProvider = _activeLibraryProvider();
    const providers = _libraryProviderSnapshot().providers || [];
    if (select) {
        select.innerHTML = providers.map(provider =>
            `<option value="${_escAttr(provider.id)}">${esc(provider.label || provider.id)}</option>`
        ).join('');
        select.value = activeProvider.id;
        select.classList.toggle('hidden', providers.length <= 1);
    }
    if (title) title.textContent = activeProvider.id === 'local' ? 'Your Library' : (activeProvider.label || activeProvider.id);
}

async function loadLibraryProviders({ restoreSaved = false, reloadOnChange = false } = {}) {
    const beforeProviderId = _activeLibraryProviderId();
    const api = _libraryProviderApi();
    if (api && typeof api.refresh === 'function') {
        await api.refresh({ restoreSaved });
    }

    _renderLibraryProviderSelector();
    const afterProviderId = _activeLibraryProviderId();
    if (reloadOnChange && afterProviderId !== beforeProviderId) {
        _resetLibraryProviderViewState();
        loadLibrary(0);
    }
}

async function setLibraryProvider(providerId, options = {}) {
    const beforeProviderId = _activeLibraryProviderId();
    try {
        const capabilityApi = window.feedBack && window.feedBack.capabilities;
        if (capabilityApi && typeof capabilityApi.command === 'function') {
            await capabilityApi.command('library', 'select-provider', {
                requester: 'app.library',
                target: { providerId },
                payload: options && typeof options === 'object' ? options : {},
            });
        } else {
            _libraryProviderApi()?.select?.(String(providerId || ''));
        }
    } catch (err) {
        // Reached from an inline onchange="setLibraryProvider(this.value)"
        // handler that does not await us, so a rejection would otherwise
        // surface as an unhandled promise rejection. Log and bail without a
        // reload. Re-render the selector so the <select> snaps back to the
        // still-active provider — the onchange already moved its displayed
        // value to the (failed) selection, which would otherwise leave the
        // dropdown showing a provider that was never actually selected.
        console.error('setLibraryProvider: failed to select provider', providerId, err);
        _renderLibraryProviderSelector();
        return;
    }
    if (beforeProviderId === _activeLibraryProviderId()) {
        // The active provider didn't change — either a genuine no-op, or the
        // capability command degraded/no-op'd without throwing (e.g. an
        // unknown provider returns a "degraded" outcome rather than rejecting).
        // The inline onchange already moved the <select>'s displayed value, so
        // re-render to snap it back to the provider that is actually active.
        _renderLibraryProviderSelector();
        return;
    }
    _renderLibraryProviderSelector();
    _resetLibraryProviderViewState();
    loadLibrary(0);
}

function _libraryProviderIdForSong(song, fallbackProviderId) {
    return String(
        song.provider_id || song.providerId || song.library_provider_id ||
        song.libraryProviderId || song.provider || fallbackProviderId || 'local'
    );
}

function _librarySongId(song) {
    const songId = song.song_id || song.songId || song.remote_id || song.remoteId || song.id || song.filename || '';
    return String(songId || '');
}

function _libraryLocalFilename(song, providerId) {
    if (_isLocalLibraryProvider(providerId)) return song.filename ? String(song.filename) : '';
    const filename = song.local_filename || song.localFilename || song.synced_filename ||
        song.syncedFilename || song.play_filename || song.playFilename || '';
    if (filename) return String(filename);
    const state = _librarySyncState(providerId, _librarySongId(song));
    return state && state.status === 'synced' && state.localFilename ? String(state.localFilename) : '';
}

function _libraryDisplayFilename(song, providerId) {
    return _libraryLocalFilename(song, providerId) || _librarySongId(song) || 'Unknown song';
}

function _librarySongTitle(song, providerId) {
    const fallback = _libraryDisplayFilename(song, providerId);
    return song.title || fallback.replace(/_p\.archive$/i, '').replace(/_/g, ' ');
}

function _librarySongArtUrl(song, providerId) {
    const explicitArt = song.art_url || song.artUrl || song.cover_url || song.coverUrl;
    if (explicitArt) return _safeImageUrl(explicitArt);
    const version = song.mtime ? `?v=${Math.floor(song.mtime)}` : '';
    const localFilename = _libraryLocalFilename(song, providerId);
    if (localFilename) return `/api/song/${encodeURIComponent(localFilename)}/art${version}`;
    if (_isLocalLibraryProvider(providerId)) return '';
    if (!_providerSupports(providerId, 'art.read')) return '';
    const songId = _librarySongId(song);
    return songId ? `/api/library/providers/${encodeURIComponent(providerId)}/songs/${encodeURIComponent(songId)}/art${version}` : '';
}

function _safeImageUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        const parsed = new URL(raw, window.location.origin);
        return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
    } catch {
        return '';
    }
}

const _librarySyncStates = new Map();

function _librarySyncKey(providerId, songId) {
    // JSON.stringify avoids delimiter collision: a newline in either value
    // would make "${p}\n${s}" ambiguous, but JSON-serialised arrays are
    // always distinct for distinct (providerId, songId) pairs.
    return JSON.stringify([providerId, songId]);
}

function _librarySyncState(providerId, songId) {
    return _librarySyncStates.get(_librarySyncKey(providerId, songId)) || null;
}

function _librarySyncStatusText(state) {
    if (!state) return '';
    if (state.status === 'syncing') return 'Loading package...';
    if (state.status === 'synced') return state.message || 'Ready to play';
    if (state.status === 'error') return state.message ? `Load failed: ${state.message}` : 'Load failed';
    return '';
}

function _librarySyncStatusClass(state, layout) {
    const base = layout === 'inline'
        ? 'library-sync-status inline-block text-[11px] ml-1'
        : 'library-sync-status block mt-1 text-[11px] leading-snug';
    if (!state) return `${base} hidden text-gray-500`;
    if (state.status === 'error') return `${base} text-red-300`;
    if (state.status === 'synced') return `${base} text-green-300`;
    return `${base} text-gray-400`;
}

function _librarySyncStatusMarkup(providerId, songId, layout = 'block') {
    const state = _librarySyncState(providerId, songId);
    return `<span data-library-sync-status role="status" aria-live="polite" data-library-sync-provider="${encodeURIComponent(providerId)}" data-library-sync-song="${encodeURIComponent(songId)}" class="${_librarySyncStatusClass(state, layout)}">${esc(_librarySyncStatusText(state))}</span>`;
}

let libView = _readPersistedChoice(_LIB_VIEW_KEY, _LIB_VIEW_VALUES, 'grid');
let currentPage = 0;
const PAGE_SIZE = 24;
// Tree letter selection persists across reloads / coming back from
// the player so the user lands on the same alphabet group they
// picked. Validation: any single uppercase letter, or `#` for
// non-alphabetical artists, or `''` for the All bucket.
const _LIB_TREE_LETTER_KEY = 'feedBack.libTreeLetter';
const _FAV_TREE_LETTER_KEY = 'feedBack.favTreeLetter';
function _readPersistedLetter(key) {
    let v = null;
    try { v = localStorage.getItem(key); } catch { return ''; }
    if (v === null) return '';
    return (v === '' || v === '#' || /^[A-Z]$/.test(v)) ? v : '';
}
function _writePersistedLetter(key, value) {
    try { localStorage.setItem(key, value || ''); } catch { /* private mode / quota */ }
}
let _treeLetter = _readPersistedLetter(_LIB_TREE_LETTER_KEY);
let _treeStats = null;
let _debounceTimer = null;
let _loadingMore = false;
let _hasMore = true;
let _gridObserver = null;
// Bumped on filter/sort/view changes so in-flight page fetches can detect
// they've been superseded and skip rendering stale results.
let _libEpoch = 0;

// ── Library filters (feedBack#129/#69) ────────────────────────────────
//
// Filter state lives in a single object so the active set can be
// serialized to localStorage as one key. Each axis is OR-within (Lead
// + Rhythm = "has Lead OR Rhythm"); cross-axis is AND. Tri-state pills
// translate to `_has` / `_lacks` lists on the wire so the server's
// SQL doesn't have to encode the third "any" state.
// In smart mode Combo is subsumed into Lead; only show Lead/Rhythm/Bass.
// In legacy mode keep the original four values.
// In-memory cache so a localStorage.setItem failure (private mode / quota /
// disabled storage) still keeps the chosen mode for the rest of the session.
// Initialised lazily from localStorage on first read.
let _arrangementNamingMode = null;
function _getArrangementNamingMode() {
    if (_arrangementNamingMode === 'smart' || _arrangementNamingMode === 'legacy') {
        return _arrangementNamingMode;
    }
    try {
        _arrangementNamingMode = localStorage.getItem('arrangementNamingMode') === 'legacy' ? 'legacy' : 'smart';
    } catch (_) {
        _arrangementNamingMode = 'smart';
    }
    return _arrangementNamingMode;
}
// In smart mode 'Combo' is subsumed into 'Lead' (_ensure_smart_names maps it
// the same way). Normalize any persisted 'Combo' tokens before querying or
// rendering so the UI and the server stay in sync.
function _toSmartArrs(arr) {
    return arr.map(a => a === 'Combo' ? 'Lead' : a);
}
function _onNamingModeChange(value) {
    const mode = value === 'legacy' ? 'legacy' : 'smart';
    _arrangementNamingMode = mode;
    try { localStorage.setItem('arrangementNamingMode', mode); } catch (_) {}
    if (mode === 'smart') {
        _libFilters.arrHas   = _toSmartArrs(_libFilters.arrHas);
        _libFilters.arrLacks = _toSmartArrs(_libFilters.arrLacks);
        _saveLibFilters();
    }
    _renderLibFilterDrawer();
    _renderLibFilterChips();
    _libEpoch++;
    currentPage = 0;
    _treeStats = null;
    loadLibrary(0);
}
function _getArrangements() {
    return _getArrangementNamingMode() === 'smart'
        ? ['Lead', 'Rhythm', 'Bass']
        : ['Lead', 'Rhythm', 'Bass', 'Combo'];
}
function _arrangementBadgeHtml(arrangement, nm) {
    const label = (nm === 'smart' && arrangement.smart_name) ? arrangement.smart_name : arrangement.name;
    const cls = label.includes('Lead')   ? 'bg-red-900/40 text-red-300' :
                label.includes('Rhythm') ? 'bg-blue-900/40 text-blue-300' :
                label.includes('Bass')   ? 'bg-green-900/40 text-green-300' :
                'bg-dark-600 text-gray-400';
    return `<span class="px-1.5 py-0.5 rounded ${cls}">${esc(label)}</span>`;
}
// Stem ids match the bare strings sloppak manifests use ("drums",
// "bass", etc.). `full` is intentionally omitted from the filter UI:
// it's the fallback mix every sloppak ships with, so filtering by it
// would match all sloppaks and confuse users.
const _STEM_DEFS = [
    { id: 'drums', label: 'Drums' },
    { id: 'bass', label: 'Bass' },
    { id: 'vocals', label: 'Vocals' },
    { id: 'guitar', label: 'Guitar' },
    { id: 'piano', label: 'Piano' },
    { id: 'other', label: 'Other' },
];
const _LIB_FILTERS_KEY = 'feedBack.libFilters';
let _libFilters = _loadLibFilters();
let _tuningNames = null;  // cached from /api/library/tuning-names

function _defaultLibFilters() {
    return {
        arrHas: [], arrLacks: [],
        stemsHas: [], stemsLacks: [],
        lyrics: null,             // null | 1 | 0
        tunings: [],
    };
}

function _normalizeStringArray(v) {
    return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : [];
}

function _normalizeLibFilters(parsed) {
    // Defensive: a stale or hand-edited localStorage payload could have
    // any shape. Without normalization a later `.join` or `.includes`
    // on a non-array would throw at filter-apply time. Coerce each
    // field back to its expected type, dropping anything we don't
    // recognize. FeedBack#134 review.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return _defaultLibFilters();
    }
    const lyrics = parsed.lyrics;
    return {
        arrHas: _normalizeStringArray(parsed.arrHas),
        arrLacks: _normalizeStringArray(parsed.arrLacks),
        stemsHas: _normalizeStringArray(parsed.stemsHas),
        stemsLacks: _normalizeStringArray(parsed.stemsLacks),
        lyrics: lyrics === 0 || lyrics === 1 ? lyrics : null,
        tunings: _normalizeStringArray(parsed.tunings),
    };
}

function _loadLibFilters() {
    try {
        const raw = localStorage.getItem(_LIB_FILTERS_KEY);
        if (!raw) return _defaultLibFilters();
        const filters = _normalizeLibFilters(JSON.parse(raw));
        // Normalize any stale 'Combo' tokens left from legacy-mode sessions.
        if (_getArrangementNamingMode() === 'smart') {
            filters.arrHas   = _toSmartArrs(filters.arrHas);
            filters.arrLacks = _toSmartArrs(filters.arrLacks);
        }
        return filters;
    } catch {
        return _defaultLibFilters();
    }
}

function _saveLibFilters() {
    try { localStorage.setItem(_LIB_FILTERS_KEY, JSON.stringify(_libFilters)); }
    catch { /* private mode / quota — ignore, in-memory state still works */ }
}

function _libActiveCount() {
    let n = 0;
    if (_libFilters.arrHas.length) n++;
    if (_libFilters.arrLacks.length) n++;
    if (_libFilters.stemsHas.length) n++;
    if (_libFilters.stemsLacks.length) n++;
    if (_libFilters.lyrics !== null) n++;
    if (_libFilters.tunings.length) n++;
    return n;
}

function _applyLibFiltersToParams(params) {
    const nm = _getArrangementNamingMode();
    params.set('naming_mode', nm);
    const arrHas   = nm === 'smart' ? _toSmartArrs(_libFilters.arrHas)   : _libFilters.arrHas;
    const arrLacks = nm === 'smart' ? _toSmartArrs(_libFilters.arrLacks) : _libFilters.arrLacks;
    if (arrHas.length)   params.set('arrangements_has',   arrHas.join(','));
    if (arrLacks.length) params.set('arrangements_lacks', arrLacks.join(','));
    if (_libFilters.stemsHas.length) params.set('stems_has', _libFilters.stemsHas.join(','));
    if (_libFilters.stemsLacks.length) params.set('stems_lacks', _libFilters.stemsLacks.join(','));
    if (_libFilters.lyrics !== null) params.set('has_lyrics', String(_libFilters.lyrics));
    if (_libFilters.tunings.length) params.set('tunings', _libFilters.tunings.join(','));
    return params;
}

function _pillState(item, hasList, lacksList) {
    if (hasList.includes(item)) return 'require';
    if (lacksList.includes(item)) return 'exclude';
    return 'any';
}

function _cyclePill(item, hasKey, lacksKey) {
    // Cycle: any -> require -> exclude -> any. Mutates _libFilters in place.
    const hasList = _libFilters[hasKey];
    const lacksList = _libFilters[lacksKey];
    const inHas = hasList.indexOf(item);
    const inLacks = lacksList.indexOf(item);
    if (inHas === -1 && inLacks === -1) {
        hasList.push(item);
    } else if (inHas !== -1) {
        hasList.splice(inHas, 1);
        lacksList.push(item);
    } else {
        lacksList.splice(inLacks, 1);
    }
    _saveLibFilters();
    _renderLibFilterDrawer();
    _renderLibFilterChips();
    _libEpoch++;
    currentPage = 0;
    _treeStats = null;  // letter bar counts depend on filters now
    loadLibrary(0);
}

function _renderPillRow(containerId, items, hasKey, lacksKey, labelFor) {
    const c = document.getElementById(containerId);
    if (!c) return;
    c.innerHTML = '';
    for (const it of items) {
        const id = typeof it === 'string' ? it : it.id;
        const label = labelFor ? labelFor(it) : id;
        const state = _pillState(id, _libFilters[hasKey], _libFilters[lacksKey]);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `filter-pill state-${state}`;
        btn.textContent = label;
        btn.onclick = () => _cyclePill(id, hasKey, lacksKey);
        c.appendChild(btn);
    }
}

function _renderLyricsPill() {
    // Single tri-state pill matching the arrangement / stem pattern.
    // Cycle: any (null) -> require (1) -> exclude (0) -> any.
    const c = document.getElementById('filter-lyrics');
    if (!c) return;
    c.innerHTML = '';
    const v = _libFilters.lyrics;
    const state = v === 1 ? 'require' : v === 0 ? 'exclude' : 'any';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `filter-pill state-${state}`;
    btn.textContent = 'Lyrics';
    btn.onclick = () => {
        _libFilters.lyrics = v === null ? 1 : v === 1 ? 0 : null;
        _saveLibFilters();
        _renderLyricsPill();
        _renderLibFilterChips();
        _libEpoch++;
        currentPage = 0;
        _treeStats = null;
        loadLibrary(0);
    };
    c.appendChild(btn);
}

async function _renderTuningList() {
    const c = document.getElementById('filter-tunings');
    if (!c) return;
    let fetchError = null;
    if (!_tuningNames) {
        const myEpoch = _libEpoch;
        c.innerHTML = '<div class="text-xs text-gray-500 px-2">Loading...</div>';
        try {
            const params = _applyLibraryProviderToParams(new URLSearchParams());
            const resp = await fetch(`/api/library/tuning-names?${params}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            // Guard against a provider switch that invalidated _tuningNames
            // while this request was in flight — discard a stale result.
            if (myEpoch !== _libEpoch) return;
            _tuningNames = Array.isArray(data.tunings) ? data.tunings : [];
        } catch (e) {
            if (myEpoch !== _libEpoch) return;
            // Distinguish a server / network failure from "the DB
            // genuinely has no tunings indexed". The latter wants a
            // Full Rescan; the former just wants a retry. Don't cache
            // the failure — leave _tuningNames null so reopening the
            // drawer triggers a fresh attempt.
            _tuningNames = null;
            fetchError = e.message || 'request failed';
        }
    }
    c.innerHTML = '';
    if (fetchError) {
        c.innerHTML = `<div class="text-xs text-red-400 px-2">Failed to load tunings (${esc(fetchError)}). Reopen the drawer to retry.</div>`;
        return;
    }
    if (!_tuningNames.length) {
        c.innerHTML = '<div class="text-xs text-gray-500 px-2">No tunings indexed yet — try Full Rescan.</div>';
        return;
    }
    for (const t of _tuningNames) {
        // Filter on the server grouping key (offsets for customs, name for named
        // tunings); label custom pills with their target notes so two "Custom
        // Tuning" entries are distinguishable. See tuning_names() in server.py.
        const val = t.key || t.name;
        let label = t.name;
        if (t.name === 'Custom Tuning' && t.offsets
            && typeof window.parseRawTuningOffsets === 'function'
            && typeof window.displayTuningTargets === 'function') {
            const offs = window.parseRawTuningOffsets(t.offsets);
            const notes = offs ? window.displayTuningTargets(offs, { tuningName: t.name }) : '';
            if (notes) label = 'Custom · ' + notes;
        }
        const checked = _libFilters.tunings.includes(val);
        const row = document.createElement('label');
        row.className = 'tuning-row';
        row.innerHTML =
            `<input type="checkbox" ${checked ? 'checked' : ''} class="rounded border-gray-600 bg-dark-700 text-accent">` +
            `<span class="flex-1">${esc(label)}</span>` +
            `<span class="tuning-count">${t.count}</span>`;
        const cb = row.querySelector('input');
        cb.onchange = () => {
            const i = _libFilters.tunings.indexOf(val);
            if (cb.checked && i === -1) _libFilters.tunings.push(val);
            else if (!cb.checked && i !== -1) _libFilters.tunings.splice(i, 1);
            _saveLibFilters();
            _updateLibFiltersBadge();
            _renderLibFilterChips();
            _renderTuningSummary();
            _libEpoch++;
            currentPage = 0;
            _treeStats = null;
            loadLibrary(0);
        };
        c.appendChild(row);
    }
    _renderTuningSummary();
}

function _renderTuningSummary() {
    const s = document.getElementById('filter-tunings-summary');
    if (!s) return;
    if (!_libFilters.tunings.length) { s.textContent = 'All tunings'; return; }
    if (_libFilters.tunings.length === 1) { s.textContent = _libFilters.tunings[0]; return; }
    s.textContent = `${_libFilters.tunings[0]} +${_libFilters.tunings.length - 1}`;
}

function _updateLibFiltersBadge() {
    const badge = document.getElementById('lib-filters-count');
    if (!badge) return;
    const n = _libActiveCount();
    badge.textContent = String(n);
    badge.classList.toggle('hidden', n === 0);
}

function _renderLibFilterDrawer() {
    _renderPillRow('filter-arrangements', _getArrangements(), 'arrHas', 'arrLacks');
    _renderPillRow('filter-stems', _STEM_DEFS, 'stemsHas', 'stemsLacks', s => s.label);
    _renderLyricsPill();
    _updateLibFiltersBadge();
}

function _renderLibFilterChips() {
    const row = document.getElementById('lib-filter-chips');
    if (!row) return;
    const chips = [];
    for (const a of _libFilters.arrHas) chips.push({ label: a, kind: 'require', remove: () => _libFilters.arrHas = _libFilters.arrHas.filter(x => x !== a) });
    for (const a of _libFilters.arrLacks) chips.push({ label: `no ${a}`, kind: 'exclude', remove: () => _libFilters.arrLacks = _libFilters.arrLacks.filter(x => x !== a) });
    for (const s of _libFilters.stemsHas) {
        const def = _STEM_DEFS.find(d => d.id === s);
        chips.push({ label: def ? def.label : s, kind: 'require', remove: () => _libFilters.stemsHas = _libFilters.stemsHas.filter(x => x !== s) });
    }
    for (const s of _libFilters.stemsLacks) {
        const def = _STEM_DEFS.find(d => d.id === s);
        chips.push({ label: `no ${def ? def.label : s}`, kind: 'exclude', remove: () => _libFilters.stemsLacks = _libFilters.stemsLacks.filter(x => x !== s) });
    }
    if (_libFilters.lyrics === 1) chips.push({ label: 'has lyrics', kind: 'require', remove: () => _libFilters.lyrics = null });
    if (_libFilters.lyrics === 0) chips.push({ label: 'no lyrics', kind: 'exclude', remove: () => _libFilters.lyrics = null });
    for (const t of _libFilters.tunings) chips.push({ label: t, kind: 'require', remove: () => _libFilters.tunings = _libFilters.tunings.filter(x => x !== t) });

    row.innerHTML = '';
    if (!chips.length) {
        row.classList.add('hidden');
        return;
    }
    row.classList.remove('hidden');
    for (const c of chips) {
        const el = document.createElement('span');
        el.className = `chip ${c.kind === 'exclude' ? 'chip-exclude' : ''}`;
        // The "×" glyph isn't a reliable accessible name; assistive tech
        // also can't depend on `title` alone. Spell out the action plus
        // the chip's label in `aria-label` so screen-reader users hear
        // "Remove filter: Lead" instead of "button" or just "×".
        const ariaLabel = `Remove filter: ${c.label}`;
        el.innerHTML =
            `${esc(c.label)}<button type="button" title="${esc(ariaLabel)}" aria-label="${esc(ariaLabel)}">×</button>`;
        el.querySelector('button').onclick = () => {
            c.remove();
            _saveLibFilters();
            _renderLibFilterDrawer();
            _renderLibFilterChips();
            _libEpoch++;
            currentPage = 0;
            _treeStats = null;
            loadLibrary(0);
        };
        row.appendChild(el);
    }
}

function toggleLibFilters(force) {
    const drawer = document.getElementById('lib-filter-drawer');
    const overlay = document.getElementById('lib-filter-overlay');
    if (!drawer) return;
    const open = force === undefined ? !drawer.classList.contains('open') : !!force;
    drawer.classList.toggle('open', open);
    overlay.classList.toggle('hidden', !open);
    if (open) {
        _renderLibFilterDrawer();
        _renderTuningList();
    }
}

function clearLibFilters() {
    _libFilters = _defaultLibFilters();
    _saveLibFilters();
    _renderLibFilterDrawer();
    _renderTuningList();
    _renderLibFilterChips();
    _libEpoch++;
    currentPage = 0;
    _treeStats = null;
    loadLibrary(0);
}

function setLibView(view) {
    libView = view;
    if (_LIB_VIEW_VALUES.has(view)) _writePersistedChoice(_LIB_VIEW_KEY, view);
    document.getElementById('lib-grid').classList.toggle('hidden', view !== 'grid');
    document.getElementById('lib-tree').classList.toggle('hidden', view !== 'tree');
    document.querySelectorAll('.lib-grid-ctrl').forEach(el => el.classList.toggle('hidden', view !== 'grid'));
    document.querySelectorAll('.lib-tree-ctrl').forEach(el => el.classList.toggle('hidden', view !== 'tree'));
    document.querySelectorAll('.lib-nontree-ctrl').forEach(el => el.classList.toggle('hidden', view === 'tree'));
    document.getElementById('view-grid-btn').className = `px-3 py-2.5 text-sm transition ${view === 'grid' ? 'text-accent-light' : 'text-gray-600 hover:text-gray-400'}`;
    document.getElementById('view-tree-btn').className = `px-3 py-2.5 text-sm transition ${view === 'tree' ? 'text-accent-light' : 'text-gray-600 hover:text-gray-400'}`;
    // Folder view
    const folderTreeEl = document.getElementById('lib-folder-tree');
    if (folderTreeEl) folderTreeEl.classList.toggle('hidden', view !== 'folder');
    const folderCtrlEl = document.getElementById('lib-folder-controls');
    if (folderCtrlEl) folderCtrlEl.classList.toggle('hidden', view !== 'folder');
    // The folder-view toolbar button only exists in the classic (v2) markup;
    // setLibView also runs at v3 startup where it's absent, so guard it (the
    // grid/tree buttons above predate this and exist on both paths).
    const folderBtnEl = document.getElementById('view-folder-btn');
    if (folderBtnEl) folderBtnEl.className = `px-3 py-2.5 text-sm transition ${view === 'folder' ? 'text-accent-light' : 'text-gray-600 hover:text-gray-400'}`;
    if (libView === 'folder' && view !== 'folder') window.folderLibrary?.unload?.();
    if (view !== 'grid') stopInfiniteScroll();
    _libEpoch++;
    // View toggle changes which container `_libNavItems` resolves
    // to (tree vs grid) — drop the cache so the next keypress
    // re-derives.
    _bumpLibNavGeneration();
    loadLibrary();
}

async function loadLibrary(page) {
    if (libView === 'grid') {
        await loadGridPage(page !== undefined ? page : currentPage);
    } else if (libView === 'tree') {
        await loadTreeView();
    } else if (libView === 'folder') {
        if (window.folderLibrary) await window.folderLibrary.load();
    }
    // v3 Songs page manages its own view state independently of libView — if
    // lib-folder-tree is visible, the folder library must also react to filter changes.
    if (libView !== 'folder' && window.folderLibrary) {
        const treeEl = document.getElementById('lib-folder-tree');
        if (treeEl && !treeEl.classList.contains('hidden')) {
            await window.folderLibrary.load();
        }
    }
}

// ── Folder Library: filter bridge ─────────────────────────────────────────
// Serialises the active lib filter state as URL params so the plugin can pass
// them to /api/plugins/folder_library/tree — the same pattern grid and tree
// views use when sending filter params to their own backend endpoints.
window.feedBackLibFilterParams = function() {
    var p = new URLSearchParams();
    _applyLibFiltersToParams(p);
    return p.toString();
};


async function _fetchJsonOrThrow(url) {
    const resp = await fetch(url);
    const raw = await resp.text();
    let data = {};
    let parseError = null;
    if (raw) {
        try {
            data = JSON.parse(raw);
        } catch (error) {
            parseError = error;
        }
    }
    if (!resp.ok) {
        const detail = String(data.detail || data.error || data.message || '').trim();
        throw new Error(detail || `HTTP ${resp.status}`);
    }
    if (parseError) throw new Error('Malformed JSON response');
    return data;
}

function _setLibraryOfflineMessage(containerId, countId, message) {
    const container = document.getElementById(containerId);
    const count = document.getElementById(countId);
    if (count) count.textContent = 'Source appears offline';
    if (container) {
        container.innerHTML = `<div class="rounded-xl border border-red-900/30 bg-red-900/10 px-4 py-6 text-sm text-red-300">${esc(message || 'This source appears to be offline.')}</div>`;
    }
}

function _setLibraryLoadingMessage(containerId, countId, message) {
    const container = document.getElementById(containerId);
    const count = document.getElementById(countId);
    if (count) count.textContent = 'Loading source...';
    if (container) {
        container.innerHTML = `<div class="rounded-xl border border-gray-800/50 bg-dark-700/30 px-4 py-6 text-sm text-gray-300">${esc(message || 'Loading library...')}</div>`;
    }
}

function _libraryLoadingText() {
    const provider = _activeLibraryProvider();
    if (!provider || provider.id === 'local' || provider.kind === 'local') {
        return 'Loading library...';
    }
    return `Connecting to ${provider.label || provider.id}...`;
}

function filterLibrary() {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => {
        _libEpoch++;
        currentPage = 0;
        _treeLetter = '';
        // Letter-bar counts depend on `q` and the active filter set —
        // any change to those must invalidate the tree-view stats
        // cache or the next switch to tree view will render stale
        // letter counts (feedBack#134 review).
        _treeStats = null;
        loadLibrary(0);
    }, 250);
}

function sortLibrary() {
    // Persist whichever of the two dropdowns just changed so the next
    // page load can restore both. Both selects route through this
    // handler today; reading both is cheap and keeps the function
    // single-purpose.
    const sortEl = document.getElementById('lib-sort');
    if (sortEl && _LIB_SORT_VALUES.has(sortEl.value)) {
        _writePersistedChoice(_LIB_SORT_KEY, sortEl.value);
    }
    const fmtEl = document.getElementById('lib-format');
    if (fmtEl && _LIB_FORMAT_VALUES.has(fmtEl.value)) {
        _writePersistedChoice(_LIB_FORMAT_KEY, fmtEl.value);
    }
    _libEpoch++;
    currentPage = 0;
    // Same reason as filterLibrary: format dropdown changes the stats
    // payload, so the cache must drop too.
    _treeStats = null;
    loadLibrary(0);
}

// ── Grid View (server-side pagination, infinite scroll) ────────────────

async function loadGridPage(page = 0) {
    const myEpoch = _libEpoch;
    const q = document.getElementById('lib-filter').value.trim();
    const sort = document.getElementById('lib-sort').value;
    const format = (document.getElementById('lib-format') || {}).value || '';
    const params = new URLSearchParams({ q, page, size: PAGE_SIZE, sort });
    if (format) params.set('format', format);
    _applyLibraryProviderToParams(params);
    _applyLibFiltersToParams(params);
    if (page === 0) {
        _setLibraryLoadingMessage('lib-grid', 'lib-count', _libraryLoadingText());
    }
    let data;
    try {
        data = await _fetchJsonOrThrow(`/api/library?${params}`);
    } catch (error) {
        if (myEpoch !== _libEpoch) return;
        currentPage = 0;
        _hasMore = false;
        stopInfiniteScroll();
        _setLibraryOfflineMessage('lib-grid', 'lib-count', error.message || 'This source appears to be offline.');
        return;
    }
    if (myEpoch !== _libEpoch) return; // filter/sort/view changed mid-fetch

    currentPage = page;
    const total = data.total || 0;
    const songs = data.songs || [];
    document.getElementById('lib-count').textContent = `${total} songs`;

    renderGridCards(songs, 'lib-grid', page === 0 ? 'replace' : 'append');

    _hasMore = (page + 1) * PAGE_SIZE < total;
    setupInfiniteScroll();
}

function setupInfiniteScroll() {
    let sentinel = document.getElementById('lib-grid-sentinel');
    if (!sentinel) {
        sentinel = document.createElement('div');
        sentinel.id = 'lib-grid-sentinel';
        sentinel.style.height = '1px';
        document.getElementById('lib-grid').after(sentinel);
    }
    stopInfiniteScroll();
    if (!_hasMore) return;
    _gridObserver = new IntersectionObserver(async (entries) => {
        if (entries[0].isIntersecting && !_loadingMore && _hasMore) {
            _loadingMore = true;
            try { await loadGridPage(currentPage + 1); }
            finally { _loadingMore = false; }
        }
    }, { rootMargin: '400px' });
    _gridObserver.observe(sentinel);
}

function stopInfiniteScroll() {
    if (_gridObserver) {
        _gridObserver.disconnect();
        _gridObserver = null;
    }
}

function formatBadge(fmt, stemCount) {
    if (fmt === 'sloppak' && (stemCount || 0) > 1) {
        return `<span class="fmt-badge absolute top-2 right-2 px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-900/80 text-purple-200 border border-purple-700">STEMS</span>`;
    }
    if (fmt === 'sloppak') {
        return `<span class="fmt-badge absolute top-2 right-2 px-1.5 py-0.5 rounded text-[10px] font-bold bg-green-900/80 text-green-200 border border-green-700">FEEDPAK</span>`;
    }
    if (fmt === 'loose') {
        return `<span class="fmt-badge absolute top-2 right-2 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-900/80 text-amber-200 border border-amber-700">FOLDER</span>`;
    }
    return '';
}

function formatBadgeInline(fmt, stemCount) {
    if (fmt === 'sloppak' && (stemCount || 0) > 1) {
        return `<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-900/60 text-purple-300">STEMS</span>`;
    }
    if (fmt === 'sloppak') {
        return `<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-green-900/60 text-green-300">FEEDPAK</span>`;
    }
    if (fmt === 'loose') {
        return `<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-900/60 text-amber-300">FOLDER</span>`;
    }
    return '';
}

function renderGridCards(songs, containerId = 'lib-grid', mode = 'replace') {
    const grid = document.getElementById(containerId);
    const screenProviderId = containerId.startsWith('fav') ? 'local' : _activeLibraryProviderId();
    const html = songs.map(song => {
        const providerId = _libraryProviderIdForSong(song, screenProviderId);
        const localFilename = _libraryLocalFilename(song, providerId);
        const songId = _librarySongId(song);
        const title = _librarySongTitle(song, providerId);
        const artist = song.artist || '';
        const duration = song.duration ? formatTime(song.duration) : '';
        const tuningRaw = song.tuning || song.tuning_name || '';
        const tuning = displayTuningName(tuningRaw);
        const artUrl = _librarySongArtUrl(song, providerId);
        const isLocalProvider = _isLocalLibraryProvider(providerId);
        const isSloppak = song.format === 'sloppak';
        // Use the canonical display label (displayTuningName names raw offset
        // strings too), not the raw token, so a row whose tuning is stored as
        // offsets still qualifies for the "Convert to E Standard" button.
        const stdRetune = isLocalProvider && localFilename && !isSloppak && tuning && !song.has_estd &&
            ['Eb Standard', 'D Standard', 'C# Standard', 'C Standard'].includes(tuning);
        const retuneBtn = stdRetune
            ? `<button data-retune="${encodeURIComponent(localFilename)}" data-title="${encodeURIComponent(title)}" data-tuning="${_escAttr(tuning)}" data-target="E Standard"
                class="retune-btn mt-2 w-full px-2 py-1.5 bg-gold/10 hover:bg-gold/20 border border-gold/20 rounded-lg text-xs font-medium text-gold transition">
                ⬆ Convert to E Standard</button>`
            : '';
        const fmtBadge = formatBadge(song.format, song.stem_count);
        const syncStatus = !localFilename ? _librarySyncStatusMarkup(providerId, songId) : '';
        const actionButtons = isLocalProvider && localFilename
            ? `${editBtn(song)}${heartBtn(localFilename, song.favorite)}`
            : '';
        const canSync = !localFilename && _providerSupports(providerId, 'song.sync');
        const isInteractive = !!localFilename || canSync;
        const providerAttr = `data-library-provider="${encodeURIComponent(providerId)}"`;
        // For provider-backed entries, keep data-library-song alongside
        // data-play once the song is synced so _restoreLibSelection can
        // still match the persisted remote selection after a re-render.
        const songAttr = !isLocalProvider ? ` data-library-song="${encodeURIComponent(songId)}"` : '';
        const entryAttrs = localFilename
            ? `data-play="${encodeURIComponent(localFilename)}" ${providerAttr}${songAttr}`
            : `data-library-provider="${encodeURIComponent(providerId)}" data-library-song="${encodeURIComponent(songId)}"`;
        const ariaAction = localFilename ? 'Play' : 'Load and play';
        const ariaLabel = `${ariaAction} ${title || _libraryDisplayFilename(song, providerId)}${artist ? ' by ' + artist : ''}`;
        const displayLabel = `${title || _libraryDisplayFilename(song, providerId)}${artist ? ' by ' + artist : ''}`;
        const interactiveAttrs = isInteractive
            ? `tabindex="0" role="button" aria-label="${_escAttr(ariaLabel)}"`
            : `role="listitem" aria-label="${_escAttr(displayLabel)}"`;
        const artHtml = artUrl
            ? `<img src="${_escAttr(artUrl)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
                <span class="placeholder" style="display:none">🎸</span>`
            : `<span class="placeholder" style="display:flex">🎸</span>`;
        return `<div class="song-card group" ${entryAttrs} data-artist="${_escAttr(artist || '')}" ${interactiveAttrs}>
            <div class="card-art">
                ${artHtml}
                ${fmtBadge}
            </div>
            <div class="p-4">
                <div class="flex items-start justify-between gap-1">
                    <div class="min-w-0">
                        <h3 class="text-sm font-semibold text-white truncate group-hover:text-accent-light transition">${esc(title)}</h3>
                        <p class="text-xs text-gray-500 truncate mt-0.5">${esc(artist)}</p>
                    </div>
                    <div class="flex gap-1">
                        ${actionButtons}
                    </div>
                </div>
                <div class="flex items-center flex-wrap gap-1.5 mt-3 text-xs">
                    ${(() => { const _nm = _getArrangementNamingMode(); return (song.arrangements || []).map(a => _arrangementBadgeHtml(a, _nm)).join(''); })()}
                    ${tuning ? `<span class="px-1.5 py-0.5 rounded ${tuning === 'E Standard' ? 'bg-green-900/30 text-green-400' : 'bg-yellow-900/30 text-yellow-400'}">${esc(tuning)}</span>` : ''}
                    ${song.has_lyrics ? `<span class="px-1.5 py-0.5 bg-purple-900/30 rounded text-purple-300">Lyrics</span>` : ''}
                    ${song.user_difficulty != null ? `<span class="px-1.5 py-0.5 bg-blue-900/30 rounded text-blue-300" title="Your difficulty rating">◆${esc(song.user_difficulty)}</span>` : ''}
                    ${duration ? `<span class="text-gray-600">${duration}</span>` : ''}
                </div>
                ${retuneBtn}
                ${syncStatus}
            </div>
        </div>`;
    }).join('');
    if (mode === 'append') {
        grid.insertAdjacentHTML('beforeend', html);
    } else {
        grid.innerHTML = html;
    }
    // Items list invalidation: any DOM mutation to the grid changes
    // the result of the next `_libNavItems` call.
    _bumpLibNavGeneration();
    // Re-apply the persistent selection after a fresh render so the
    // user's last picked card stays highlighted across reloads / a
    // round-trip through the player. Skip this during `append` mode
    // (infinite scroll) so restoring selection can't re-center the
    // viewport and yank the user away from the newly loaded page.
    // When a search input is focused the user is actively filtering —
    // re-apply the highlight but don't move the viewport (they didn't
    // leave the page and their scroll position should be preserved).
    if (mode !== 'append') {
        const screen = containerId.startsWith('fav') ? 'favorites' : 'home';
        // Scroll only on the first render after a screen entry —
        // routine search / sort / filter renders re-apply the
        // highlight without moving the viewport. The flag is
        // one-shot and consumed here.
        const scroll = _libScrollOnNextRender[screen];
        if (scroll) _libScrollOnNextRender[screen] = false;
        _restoreLibSelection(grid, screen, { scroll });
    }
}

// ── Tree View (server-side) ─────────────────────────────────────────────

async function loadTreeView() {
    const myEpoch = _libEpoch;
    if (!_treeStats) {
        _setLibraryLoadingMessage('lib-tree', 'lib-count', _libraryLoadingText());
        const q = document.getElementById('lib-filter').value.trim();
        const format = (document.getElementById('lib-format') || {}).value || '';
        const sp = new URLSearchParams();
        if (q) sp.set('q', q);
        if (format) sp.set('format', format);
        _applyLibraryProviderToParams(sp);
        _applyLibFiltersToParams(sp);
        const qs = sp.toString();
        try {
            _treeStats = await _fetchJsonOrThrow(`/api/library/stats${qs ? '?' + qs : ''}`);
        } catch (error) {
            if (myEpoch !== _libEpoch) return;
            _treeStats = null;
            _setLibraryOfflineMessage('lib-tree', 'lib-count', error.message || 'This source appears to be offline.');
            return;
        }
        if (myEpoch !== _libEpoch) return;
    }
    const q = document.getElementById('lib-filter').value.trim();
    await renderTreeInto('lib-tree', 'lib-count', _treeStats, _treeLetter, q, false, undefined, myEpoch);
}

let _treePage = 0;
const TREE_PAGE_SIZE = 50;

async function renderTreeInto(containerId, countId, stats, letter, q, favoritesOnly, page, expectedEpoch = _libEpoch) {
    if (page === undefined) page = favoritesOnly ? _favTreePage || 0 : _treePage;
    const container = document.getElementById(containerId);
    const screenProviderId = favoritesOnly ? 'local' : _activeLibraryProviderId();
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'.split('');
    const chevron = `<svg class="chevron w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>`;

    const letterFn = favoritesOnly ? 'filterFavTreeLetter' : 'filterTreeLetter';
    const pageFn = favoritesOnly ? 'goFavTreePage' : 'goTreePage';
    let html = '<div class="flex flex-wrap gap-1 mb-6">';
    html += `<button onclick="${letterFn}('')" class="px-2 py-1 rounded text-xs transition ${
        !letter ? 'bg-accent text-white' : 'bg-dark-700 text-gray-400 hover:text-white'
    }">All</button>`;
    for (const l of letters) {
        const count = stats.letters[l] || 0;
        const active = letter === l;
        html += `<button onclick="${letterFn}('${l}')" class="px-2 py-1 rounded text-xs transition ${
            active ? 'bg-accent text-white' :
            count ? 'bg-dark-700 text-gray-300 hover:text-white' :
            'bg-dark-700/50 text-gray-700 cursor-default'
        }" ${count ? '' : 'disabled'}>${l}</button>`;
    }
    html += '</div>';

    // Fetch artists for the selected letter/all
    const params = new URLSearchParams();
    if (letter) params.set('letter', letter);
    if (q) params.set('q', q);
    if (favoritesOnly) params.set('favorites', '1');
    else _applyLibraryProviderToParams(params);
    const format = (document.getElementById('lib-format') || {}).value || '';
    if (format) params.set('format', format);
    if (!favoritesOnly) _applyLibFiltersToParams(params);
    params.set('page', page);
    params.set('size', TREE_PAGE_SIZE);
    let data;
    try {
        data = await _fetchJsonOrThrow(`/api/library/artists?${params}`);
    } catch (error) {
        if (expectedEpoch !== _libEpoch) return;
        _setLibraryOfflineMessage(containerId, countId, error.message || 'This source appears to be offline.');
        return;
    }
    if (expectedEpoch !== _libEpoch) return;
    const artists = data.artists || [];
    const totalArtists = data.total_artists || 0;
    const totalPages = Math.ceil(totalArtists / TREE_PAGE_SIZE);

    let songCount = 0, artistCount = artists.length;
    for (const a of artists) songCount += a.song_count;
    const pageInfo = totalPages > 1 ? ` · Page ${page + 1} of ${totalPages}` : '';
    document.getElementById(countId).textContent =
        `${totalArtists} artists (${songCount} songs on this page)${pageInfo}`;

    // A previous Expand/Collapse-All click is persisted as '1'/'0' and
    // overrides the auto-open heuristic for both artists and albums.
    // Library and Favorites have independent buttons and independent
    // keys (feedBack.libTreeExpand vs feedBack.favTreeExpand) — fed
    // off the favoritesOnly flag — so toggling one doesn't flip the
    // other's state. Falsy / unset key → fall back to the existing
    // heuristic (open when there's an active search or few rows).
    const expandKey = favoritesOnly ? _FAV_TREE_EXPAND_KEY : _LIB_TREE_EXPAND_KEY;
    const savedExpand = _readPersistedChoice(expandKey, _LIB_TREE_EXPAND_VALUES, null);
    const forceArtistOpen = savedExpand === '1';
    const forceArtistClosed = savedExpand === '0';

    for (const artist of artists) {
        const heuristicOpen = q || artists.length <= 5;
        const isOpen = forceArtistOpen ? true : forceArtistClosed ? false : heuristicOpen;
        const openClass = isOpen ? ' open' : '';
        const artistAria = _escAttr(`Toggle artist ${artist.name}`);
        html += `<div class="artist-row${openClass}">`;
        html += `<div class="artist-header" tabindex="0" role="button" aria-expanded="${isOpen ? 'true' : 'false'}" aria-label="${artistAria}" onclick="_onHeaderClick(this)">`;
        html += chevron;
        html += `<span class="text-white font-semibold text-sm flex-1">${esc(artist.name)}</span>`;
        html += `<span class="text-xs text-gray-600">${artist.song_count} song${artist.song_count !== 1 ? 's' : ''} · ${artist.album_count} album${artist.album_count !== 1 ? 's' : ''}</span>`;
        html += `</div><div class="artist-body">`;

        for (const album of artist.albums) {
            const albumSongs = Array.isArray(album.songs) ? album.songs : [];
            const artSong = albumSongs[0] || {};
            const artProviderId = _libraryProviderIdForSong(artSong, screenProviderId);
            const artUrl = _librarySongArtUrl(artSong, artProviderId);
            const albumHeuristicOpen = q || artist.albums.length === 1;
            const albumIsOpen = forceArtistOpen ? true : forceArtistClosed ? false : albumHeuristicOpen;
            const albumOpen = albumIsOpen ? ' open' : '';
            const albumAria = _escAttr(`Toggle album ${album.name}`);
            html += `<div class="album-group${albumOpen}">`;
            html += `<div class="album-header" tabindex="0" role="button" aria-expanded="${albumIsOpen ? 'true' : 'false'}" aria-label="${albumAria}" onclick="_onHeaderClick(this)">`;
            html += chevron;
            if (artUrl) html += `<img src="${_escAttr(artUrl)}" alt="" class="album-art-sm" loading="lazy" onerror="this.style.display='none'">`;
            html += `<span class="text-gray-300 text-sm flex-1">${esc(album.name)}</span>`;
            html += `<span class="text-xs text-gray-600">${albumSongs.length}</span>`;
            html += `</div><div class="album-body">`;

            for (const song of albumSongs) {
                const providerId = _libraryProviderIdForSong(song, screenProviderId);
                const localFilename = _libraryLocalFilename(song, providerId);
                const songId = _librarySongId(song);
                const title = _librarySongTitle(song, providerId);
                const duration = song.duration ? formatTime(song.duration) : '';
                const tuningRaw = song.tuning || song.tuning_name || '';
                const tuning = displayTuningName(tuningRaw);
                const isLocalProvider = _isLocalLibraryProvider(providerId);
                const isSloppak = song.format === 'sloppak';
                const stdRetune = isLocalProvider && localFilename && !isSloppak && tuningRaw && !song.has_estd &&
                    ['Eb Standard', 'D Standard', 'C# Standard', 'C Standard'].includes(tuningRaw);
                const canSyncRow = !localFilename && _providerSupports(providerId, 'song.sync');
                const isInteractiveRow = !!localFilename || canSyncRow;
                const providerAttr = `data-library-provider="${encodeURIComponent(providerId)}"`;
                // Keep data-library-song alongside data-play for provider-backed
                // entries once synced so _restoreLibSelection can still find the
                // card after a post-sync re-render.
                const rowSongAttr = !isLocalProvider ? ` data-library-song="${encodeURIComponent(songId)}"` : '';
                const rowAttrs = localFilename
                    ? `data-play="${encodeURIComponent(localFilename)}" ${providerAttr}${rowSongAttr}`
                    : `data-library-provider="${encodeURIComponent(providerId)}" data-library-song="${encodeURIComponent(songId)}"`;
                const ariaAction = localFilename ? 'Play' : 'Load and play';
                const rowAria = _escAttr(`${ariaAction} ${title}${artist.name ? ' by ' + artist.name : ''}`);
                const rowDisplayLabel = `${title}${artist.name ? ' by ' + artist.name : ''}`;
                const rowInteractiveAttrs = isInteractiveRow
                    ? `tabindex="0" role="button" aria-label="${rowAria}"`
                    : `role="listitem" aria-label="${_escAttr(rowDisplayLabel)}"`;
                html += `<div class="song-row" ${rowAttrs} data-artist="${_escAttr(artist.name || '')}" ${rowInteractiveAttrs}>`;
                html += `<div class="flex-1 min-w-0 flex items-center gap-2"><span class="text-sm text-white truncate block">${esc(title)}</span>${formatBadgeInline(song.format, song.stem_count)}</div>`;
                html += `<div class="flex items-center gap-1.5 flex-shrink-0 text-xs">`;
                { const _nm = _getArrangementNamingMode();
                  for (const arrangement of (song.arrangements || []))
                      html += _arrangementBadgeHtml(arrangement, _nm); }
                if (tuning)
                    html += `<span class="px-1.5 py-0.5 rounded ${tuning === 'E Standard' ? 'bg-green-900/30 text-green-400' : 'bg-yellow-900/30 text-yellow-400'}">${esc(tuning)}</span>`;
                if (song.has_lyrics)
                    html += `<span class="px-1.5 py-0.5 bg-purple-900/30 rounded text-purple-300">Lyrics</span>`;
                if (song.user_difficulty != null)
                    html += `<span class="px-1.5 py-0.5 bg-blue-900/30 rounded text-blue-300" title="Your difficulty rating">◆${esc(song.user_difficulty)}</span>`;
                if (duration)
                    html += `<span class="text-gray-600 w-10 text-right">${duration}</span>`;
                if (stdRetune)
                    html += `<button data-retune="${encodeURIComponent(localFilename)}" data-title="${encodeURIComponent(title)}" data-tuning="${_escAttr(tuningRaw)}" data-target="E Standard"
                        class="retune-btn px-1.5 py-0.5 bg-gold/10 hover:bg-gold/20 border border-gold/20 rounded text-gold" title="Convert to E Standard">E</button>`;
                if (isLocalProvider && localFilename) {
                    html += editBtn(song);
                    html += heartBtn(localFilename, song.favorite);
                } else if (!localFilename) {
                    html += _librarySyncStatusMarkup(providerId, songId, 'inline');
                }
                html += `</div></div>`;
            }
            html += `</div></div>`;
        }
        html += `</div></div>`;
    }

    // Pagination
    if (totalPages > 1) {
        html += '<div class="flex items-center justify-center gap-2 py-6">';
        html += `<button onclick="${pageFn}(0)" class="px-3 py-1.5 rounded-lg text-xs ${page === 0 ? 'text-gray-600' : 'bg-dark-600 text-gray-300 hover:bg-dark-500'}" ${page === 0 ? 'disabled' : ''}>« First</button>`;
        html += `<button onclick="${pageFn}(${page - 1})" class="px-3 py-1.5 rounded-lg text-xs ${page === 0 ? 'text-gray-600' : 'bg-dark-600 text-gray-300 hover:bg-dark-500'}" ${page === 0 ? 'disabled' : ''}>‹ Prev</button>`;
        const start = Math.max(0, page - 2);
        const end = Math.min(totalPages, start + 5);
        for (let i = start; i < end; i++) {
            html += `<button onclick="${pageFn}(${i})" class="px-3 py-1.5 rounded-lg text-xs ${i === page ? 'bg-accent text-white' : 'bg-dark-600 text-gray-300 hover:bg-dark-500'}">${i + 1}</button>`;
        }
        html += `<button onclick="${pageFn}(${page + 1})" class="px-3 py-1.5 rounded-lg text-xs ${page >= totalPages - 1 ? 'text-gray-600' : 'bg-dark-600 text-gray-300 hover:bg-dark-500'}" ${page >= totalPages - 1 ? 'disabled' : ''}>Next ›</button>`;
        html += `<button onclick="${pageFn}(${totalPages - 1})" class="px-3 py-1.5 rounded-lg text-xs ${page >= totalPages - 1 ? 'text-gray-600' : 'bg-dark-600 text-gray-300 hover:bg-dark-500'}" ${page >= totalPages - 1 ? 'disabled' : ''}>Last »</button>`;
        html += '</div>';
    }

    container.innerHTML = html;
    // Items list invalidation — see grid render counterpart.
    _bumpLibNavGeneration();
    // Re-apply the persisted selection. For the tree we also expand
    // every collapsed ancestor of the saved row so the highlight is
    // actually visible — see _restoreLibSelection. Scroll only on
    // the first render after a screen entry (one-shot flag set in
    // showScreen) so routine renders don't yank the viewport.
    const screen = favoritesOnly ? 'favorites' : 'home';
    const scroll = _libScrollOnNextRender[screen];
    if (scroll) _libScrollOnNextRender[screen] = false;
    _restoreLibSelection(container, screen, { scroll });
}

function goTreePage(p) {
    _treePage = Math.max(0, p);
    loadTreeView();
    document.getElementById('library-section').scrollIntoView({ behavior: 'smooth' });
}

function filterTreeLetter(letter) {
    _treeLetter = (_treeLetter === letter) ? '' : letter;
    _treePage = 0;
    _writePersistedLetter(_LIB_TREE_LETTER_KEY, _treeLetter);
    loadTreeView();
}

function _toggleAllInTree(containerId, expand, persistKey) {
    // Scope the open/close to the named tree's container so toggling
    // Library doesn't flip the (offscreen) Favorites DOM and vice
    // versa — they share `.artist-row` / `.album-group` classes.
    const container = document.getElementById(containerId);
    if (!container) return;
    container.querySelectorAll('.artist-row').forEach(el => el.classList.toggle('open', expand));
    container.querySelectorAll('.album-group').forEach(el => el.classList.toggle('open', expand));
    // Bulk open/close changes which song-rows pass the visibility
    // filter in `_libNavItems` — same reason `_toggleHeader` bumps
    // the generation. Without this, a stale cached items list from
    // before the toggle would let arrow nav step into now-hidden
    // rows.
    _bumpLibNavGeneration();
    // Persist the explicit choice so the next page reload (or letter
    // change, which re-runs renderTreeInto) honors it instead of
    // falling back to the auto-open heuristic. Stored as '1'/'0' so a
    // missing key reliably means "no explicit choice".
    _writePersistedChoice(persistKey, expand ? '1' : '0');
}

function toggleAllArtists(expand) {
    _toggleAllInTree('lib-tree', expand, _LIB_TREE_EXPAND_KEY);
}

function toggleAllFavoriteArtists(expand) {
    _toggleAllInTree('fav-tree', expand, _FAV_TREE_EXPAND_KEY);
}

// Display-only tuning label helpers — never mutate offsets or affect playback.
function _looksLikeRawTuningOffsets(str) {
    if (!str || typeof str !== 'string') return false;
    const s = str.trim();
    if (!s) return false;
    if (/^-?\d+$/.test(s)) return true;
    if (/^-?\d+(?: -?\d+)+$/.test(s)) return true;
    if (/^-?\d+(?:,-?\d+)+$/.test(s)) return true;
    if (/^-?\d+(-?\d+){2,}$/.test(s)) return true;
    return false;
}

function _tuningNameFromOffsets(offsets) {
    if (!offsets || !offsets.length) return '';
    const standard = {
        0: 'E Standard', '-1': 'Eb Standard', '-2': 'D Standard',
        '-3': 'C# Standard', '-4': 'C Standard', '-5': 'B Standard',
        '-6': 'Bb Standard', '-7': 'A Standard',
        1: 'F Standard', 2: 'F# Standard',
    };
    // Uniform offsets across 4 (bass) / 5 / 6 strings name the same Standard;
    // a 4-string bass [0,0,0,0] must read "E Standard", not "Custom Tuning".
    if (offsets.length >= 4 && offsets.every((o) => o === offsets[0])) {
        const name = standard[offsets[0]];
        if (name) return name;
    }
    if (offsets.length >= 4 && offsets[0] === offsets[1] - 2
            && offsets.slice(1).every((o) => o === offsets[1])) {
        const noteNames = ['E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B', 'C', 'C#', 'D', 'Eb'];
        return 'Drop ' + noteNames[((offsets[0] % 12) + 12) % 12];
    }
    const named = {
        '-2,0,0,0,0,0': 'Drop D',
        '-4,-2,-2,-2,-2,-2': 'Drop C',
        '-2,-2,0,0,0,0': 'Double Drop D',
        '0,0,0,-1,0,0': 'Open G',
        '-2,-2,0,0,-2,-2': 'Open D',
        '-2,0,0,0,-2,0': 'DADGAD',
        '0,2,2,1,0,0': 'Open E',
        '-2,0,0,2,3,2': 'Open D (alt)',
    };
    if (offsets.length === 6) {
        const key = offsets.join(',');
        if (named[key]) return named[key];
    }
    return 'Custom Tuning';
}

function displayTuningName(value, offsets) {
    // Explicit offsets win — always name them.
    if (Array.isArray(offsets) && offsets.length > 0) {
        return _tuningNameFromOffsets(offsets);
    }
    if (value && typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed || trimmed === 'Unknown') return '';
        if (!_looksLikeRawTuningOffsets(trimmed)) {
            return trimmed;
        }
        // A raw offset string (now served by the API) — parse and name it so a
        // known tuning like "-1 -1 -1 -1 -1 -1" reads "Eb Standard" rather than
        // collapsing to "Custom Tuning".
        const parsed = (typeof parseRawTuningOffsets === 'function')
            ? parseRawTuningOffsets(trimmed) : null;
        if (parsed && parsed.length) return _tuningNameFromOffsets(parsed);
        return 'Custom Tuning';
    }
    return '';
}

window.displayTuningName = displayTuningName;
window.feedBack = window.feedBack || {};
window.slopsmith = window.feedBack;
window.feedBack.displayTuningName = displayTuningName;

function isBassArrangement(context) {
    const ctx = context && typeof context === 'object' ? context : {};
    if (typeof ctx.isBass === 'boolean') return ctx.isBass;
    const label = ((ctx.arrangement || '') + ' ' + (ctx.arrangement_smart_name || '')).toLowerCase();
    if (/\bbass\b/.test(label)) return true;
    if (/\b(lead|rhythm|combo|guitar)\b/.test(label)) return false;
    return false;
}

function effectiveStringCount(offsets, context) {
    if (!Array.isArray(offsets) || !offsets.length) return 0;
    const ctx = context && typeof context === 'object' ? context : {};
    const isBass = isBassArrangement(ctx);
    let sc = ctx.stringCount > 0 ? Number(ctx.stringCount) : 0;
    if (!isBass) {
        if (sc > 0 && sc <= 5 && offsets.length >= 6) sc = 6;
        if (!sc) sc = offsets.length >= 6 ? offsets.length : 6;
    } else if (!sc) {
        sc = offsets.length >= 5 ? offsets.length : 4;
    }
    return Math.min(sc, offsets.length);
}

function songTuningContext(songInfo) {
    if (!songInfo || typeof songInfo !== 'object') return {};
    return {
        stringCount: songInfo.stringCount,
        arrangement: songInfo.arrangement,
        arrangement_smart_name: songInfo.arrangement_smart_name,
    };
}

window.feedBack.isBassArrangement = isBassArrangement;
window.feedBack.effectiveStringCount = effectiveStringCount;
window.feedBack.songTuningContext = songTuningContext;

// Open-string target notes (display only) — mirrors plugins/tuner/utils/tuning-utils.js.
const _TUNING_BASE_MIDI = {
    4: [28, 33, 38, 43],
    5: [23, 28, 33, 38, 43],
    6: [40, 45, 50, 55, 59, 64],
    7: [35, 40, 45, 50, 55, 59, 64],
    8: [30, 35, 40, 45, 50, 55, 59, 64],
};
const _TUNING_NOTE_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const _TUNING_NOTE_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

function _tuningMidiToFreq(m) {
    return Math.pow(2, (m - 69) / 12) * 440;
}

function _tuningOffsetsToFreqs(offsets, isBass) {
    const len = offsets.length;
    let base;
    if (len === 4 || len === 5) {
        base = isBass ? _TUNING_BASE_MIDI[len] : _TUNING_BASE_MIDI[6];
    } else {
        base = _TUNING_BASE_MIDI[len] || _TUNING_BASE_MIDI[6];
    }
    return offsets.map((offset, i) => {
        const root = i < base.length ? base[i] : base[base.length - 1];
        return _tuningMidiToFreq(root + offset);
    });
}

function _noteNameFromFreq(freq, useFlats) {
    const midi = 69 + 12 * Math.log2(freq / 440);
    const rounded = Math.round(midi);
    const names = useFlats ? _TUNING_NOTE_FLAT : _TUNING_NOTE_SHARP;
    return names[((rounded % 12) + 12) % 12];
}

function _octaveNoteFromFreq(freq, useFlats) {
    const midi = 69 + 12 * Math.log2(freq / 440);
    const rounded = Math.round(midi);
    const octave = Math.floor(rounded / 12) - 1;
    return _noteNameFromFreq(freq, useFlats) + octave;
}

function _stringOrdinalLabel(n) {
    const v = n % 100;
    if (v >= 11 && v <= 13) return n + 'th';
    const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
    return n + suffix;
}

function _tuningTargetFreqs(offsets, context) {
    if (!Array.isArray(offsets) || !offsets.length) return [];
    const ctx = context && typeof context === 'object' ? context : {};
    const stringCount = effectiveStringCount(offsets, ctx);
    const trimmed = offsets.slice(0, stringCount);
    if (!trimmed.length) return [];
    const isBass = isBassArrangement(ctx);
    try {
        return _tuningOffsetsToFreqs(trimmed, isBass);
    } catch (_) {
        return [];
    }
}

// Flat vs sharp spelling. A caller that knows the preference can pass
// ctx.useFlats; otherwise we infer from a flat-keyed tuning name. The v3
// card/HUD pass "Custom Tuning" (raw offsets carry no key), so those default
// to sharps unless an explicit useFlats is supplied.
function _resolveTargetUseFlats(ctx) {
    if (typeof ctx.useFlats === 'boolean') return ctx.useFlats;
    return typeof ctx.tuningName === 'string' && /\b[A-G]b\b/.test(ctx.tuningName);
}

function displayTuningTargetDetails(offsets, context) {
    const ctx = context && typeof context === 'object' ? context : {};
    const useFlats = _resolveTargetUseFlats(ctx);
    const freqs = _tuningTargetFreqs(offsets, ctx);
    return freqs.map((f, i) => {
        const stringNumber = freqs.length - i;
        const note = _noteNameFromFreq(f, useFlats);
        const octaveNote = _octaveNoteFromFreq(f, useFlats);
        return {
            stringNumber,
            note,
            octaveNote,
            title: _stringOrdinalLabel(stringNumber) + ' string: ' + octaveNote,
        };
    });
}

function displayTuningTargets(offsets, context) {
    const ctx = context && typeof context === 'object' ? context : {};
    const useFlats = _resolveTargetUseFlats(ctx);
    const freqs = _tuningTargetFreqs(offsets, ctx);
    if (!freqs.length) return '';
    return freqs.map((f) => _noteNameFromFreq(f, useFlats)).join(' ');
}

function parseRawTuningOffsets(value) {
    if (Array.isArray(value) && value.length) return value;
    if (!value || typeof value !== 'string') return null;
    const s = value.trim();
    if (/^-?\d+(?: -?\d+)+$/.test(s)) {
        return s.split(/\s+/).map((n) => Number(n));
    }
    if (/^-?\d+(?:,-?\d+)+$/.test(s)) {
        return s.split(',').map((n) => Number(n));
    }
    return null;
}

window.displayTuningTargets = displayTuningTargets;
window.displayTuningTargetDetails = displayTuningTargetDetails;
window.parseRawTuningOffsets = parseRawTuningOffsets;
window.feedBack.displayTuningTargets = displayTuningTargets;
window.feedBack.displayTuningTargetDetails = displayTuningTargetDetails;
window.feedBack.parseRawTuningOffsets = parseRawTuningOffsets;

function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

// `esc()` escapes the HTML-content metacharacters (<, >, &) but not
// quotes — fine for text-node interpolation but unsafe when the
// result is used as an attribute value, where a literal `"` ends the
// attribute early. Use `_escAttr` for any `attr="${...}"` site.
function _escAttr(s) {
    return esc(s == null ? '' : String(s))
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Toggle an artist/album header's parent `.open` state and keep
// `aria-expanded` on the header itself in sync so screen readers
// announce the collapsed/expanded transition correctly. Used by
// both the inline onclick (mouse) and the keyboard handlers.
function _toggleHeader(headerEl) {
    if (!headerEl) return;
    const parent = headerEl.parentElement;
    if (!parent) return;
    parent.classList.toggle('open');
    headerEl.setAttribute('aria-expanded', parent.classList.contains('open') ? 'true' : 'false');
    // Toggling open/closed changes which song-rows pass the
    // visibility filter in `_libNavItems`, so the cached items list
    // is now stale.
    _bumpLibNavGeneration();
}

// Called by the inline onclick on artist- and album-headers so the
// mouse-click path also syncs the persistent `.selected` state —
// keeps arrow-nav resuming from the last-clicked header rather than
// from a stale highlight on a different element.
function _onHeaderClick(el) {
    _toggleHeader(el);
    _setLibSelection(el, { focus: false });
}

// ── Favorites ────────────────────────────────────────────────────────────
let favView = 'grid';
let favPage = 0;
let _favTreeLetter = _readPersistedLetter(_FAV_TREE_LETTER_KEY);
let _favTreePage = 0;
let _favTreeStats = null;
let _favDebounce = null;

function heartBtn(filename, isFav) {
    return `<button data-fav="${encodeURIComponent(filename)}" class="fav-btn text-lg leading-none transition ${isFav ? 'text-red-500' : 'text-gray-600 hover:text-red-400'}" title="Toggle favorite">${isFav ? '&#9829;' : '&#9825;'}</button>`;
}

function editBtn(song) {
    return `<button data-edit='${JSON.stringify({f:song.filename,t:song.title||'',a:song.artist||'',al:song.album||'',y:song.year||''}).replace(/'/g,"&#39;")}' class="edit-btn text-gray-600 hover:text-accent-light transition" title="Edit metadata"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg></button>`;
}

async function toggleFavorite(filename) {
    const resp = await fetch('/api/favorites/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
    });
    const data = await resp.json();
    // Refresh whichever view is active
    const activeScreen = document.querySelector('.screen.active');
    if (activeScreen?.id === 'favorites') loadFavorites();
    else loadLibrary();
    return data.favorite;
}

function setFavView(view) {
    favView = view;
    document.getElementById('fav-grid').classList.toggle('hidden', view !== 'grid');
    document.getElementById('fav-tree').classList.toggle('hidden', view !== 'tree');
    document.querySelectorAll('.fav-grid-ctrl').forEach(el => el.classList.toggle('hidden', view !== 'grid'));
    document.querySelectorAll('.fav-tree-ctrl').forEach(el => el.classList.toggle('hidden', view !== 'tree'));
    document.getElementById('fav-view-grid-btn').className = `px-3 py-2.5 text-sm transition ${view === 'grid' ? 'text-accent-light' : 'text-gray-600 hover:text-gray-400'}`;
    document.getElementById('fav-view-tree-btn').className = `px-3 py-2.5 text-sm transition ${view === 'tree' ? 'text-accent-light' : 'text-gray-600 hover:text-gray-400'}`;
    const pag = document.getElementById('fav-pagination');
    if (pag && view !== 'grid') pag.innerHTML = '';
    // Same reason as setLibView: dropping the items cache so the
    // next keypress re-derives against the now-active container.
    _bumpLibNavGeneration();
    loadFavorites();
}

async function loadFavorites() {
    if (favView === 'grid') await loadFavGridPage(favPage);
    else await loadFavTreeView();
}

function filterFavorites() {
    clearTimeout(_favDebounce);
    _favDebounce = setTimeout(() => { favPage = 0; _favTreeLetter = ''; loadFavorites(); }, 250);
}

function sortFavorites() { favPage = 0; loadFavorites(); }

async function loadFavGridPage(page = 0) {
    const q = document.getElementById('fav-filter').value.trim();
    const sort = document.getElementById('fav-sort').value;
    favPage = page;
    const params = new URLSearchParams({ q, page, size: PAGE_SIZE, sort, favorites: 1 });
    const resp = await fetch(`/api/library?${params}`);
    const data = await resp.json();
    const totalPages = Math.ceil((data.total || 0) / PAGE_SIZE);
    document.getElementById('fav-count').textContent =
        `${data.total || 0} favorites · Page ${favPage + 1} of ${Math.max(1, totalPages)}`;
    renderGridCards(data.songs || [], 'fav-grid');
    renderFavPagination(totalPages);
}

function renderFavPagination(totalPages) {
    let pag = document.getElementById('fav-pagination');
    if (!pag) {
        pag = document.createElement('div');
        pag.id = 'fav-pagination';
        pag.className = 'flex items-center justify-center gap-2 py-6';
        document.getElementById('fav-grid').after(pag);
    }
    if (totalPages <= 1) { pag.innerHTML = ''; return; }
    let html = '';
    html += `<button onclick="goFavPage(0)" class="px-3 py-1.5 rounded-lg text-xs ${favPage === 0 ? 'text-gray-600 cursor-default' : 'bg-dark-600 text-gray-300 hover:bg-dark-500'}" ${favPage === 0 ? 'disabled' : ''}>« First</button>`;
    html += `<button onclick="goFavPage(${favPage - 1})" class="px-3 py-1.5 rounded-lg text-xs ${favPage === 0 ? 'text-gray-600 cursor-default' : 'bg-dark-600 text-gray-300 hover:bg-dark-500'}" ${favPage === 0 ? 'disabled' : ''}>‹ Prev</button>`;
    const start = Math.max(0, favPage - 2);
    const end = Math.min(totalPages, start + 5);
    for (let i = start; i < end; i++) {
        html += `<button onclick="goFavPage(${i})" class="px-3 py-1.5 rounded-lg text-xs ${i === favPage ? 'bg-accent text-white' : 'bg-dark-600 text-gray-300 hover:bg-dark-500'}">${i + 1}</button>`;
    }
    html += `<button onclick="goFavPage(${favPage + 1})" class="px-3 py-1.5 rounded-lg text-xs ${favPage >= totalPages - 1 ? 'text-gray-600 cursor-default' : 'bg-dark-600 text-gray-300 hover:bg-dark-500'}" ${favPage >= totalPages - 1 ? 'disabled' : ''}>Next ›</button>`;
    html += `<button onclick="goFavPage(${totalPages - 1})" class="px-3 py-1.5 rounded-lg text-xs ${favPage >= totalPages - 1 ? 'text-gray-600 cursor-default' : 'bg-dark-600 text-gray-300 hover:bg-dark-500'}" ${favPage >= totalPages - 1 ? 'disabled' : ''}>Last »</button>`;
    pag.innerHTML = html;
}

function goFavPage(p) { loadFavGridPage(Math.max(0, p)); }

async function loadFavTreeView() {
    if (!_favTreeStats) {
        const resp = await fetch('/api/library/stats?favorites=1');
        _favTreeStats = await resp.json();
    }
    const q = document.getElementById('fav-filter').value.trim();
    const letter = _favTreeLetter;
    // Reuse the tree renderer with fav-tree container and fav-count
    await renderTreeInto('fav-tree', 'fav-count', _favTreeStats, letter, q, true);
}

function filterFavTreeLetter(letter) {
    _favTreeLetter = (_favTreeLetter === letter) ? '' : letter;
    _favTreePage = 0;
    _writePersistedLetter(_FAV_TREE_LETTER_KEY, _favTreeLetter);
    loadFavTreeView();
}

function goFavTreePage(p) {
    _favTreePage = Math.max(0, p);
    loadFavTreeView();
}

// ── Settings ─────────────────────────────────────────────────────────────
let _defaultArrangement = '';

const INSTRUMENT_PATHWAYS = ['songs', 'practice', 'learn', 'studio'];

function _normalizeInstrumentPathway(value) {
    return INSTRUMENT_PATHWAYS.includes(value) ? value : 'songs';
}

function _syncDefaultArrangementSelect(value) {
    const sel = document.getElementById('default-arrangement');
    if (!sel) return;
    const wanted = value || '';
    const existing = Array.from(sel.options).find(opt => opt.value === wanted);
    const dynamic = sel.querySelector('option[data-dynamic-default-arrangement]');
    if (dynamic && dynamic.value !== wanted) dynamic.remove();
    if (wanted && !existing) {
        const opt = document.createElement('option');
        opt.value = wanted;
        opt.textContent = `${wanted} (saved default)`;
        opt.dataset.dynamicDefaultArrangement = 'true';
        sel.appendChild(opt);
    }
    sel.value = wanted;
}

function _currentArrangementName() {
    const song = window.feedBack?.currentSong;
    const sel = document.getElementById('arr-select');
    if (song?.arrangements && sel) {
        const match = song.arrangements.find(a => String(a.index) === String(sel.value));
        if (match?.name) return String(match.name);
    }
    if (song?.arrangement) return String(song.arrangement);
    const selectedText = sel?.selectedOptions?.[0]?.textContent || '';
    return selectedText.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function syncDefaultArrangementPin() {
    const btn = document.getElementById('arr-default-pin');
    if (!btn) return;
    const name = _currentArrangementName();
    const isDefault = !!name && name === _defaultArrangement;
    const label = name
        ? (isDefault ? `${name} is the default arrangement` : `Make ${name} the default for new songs`)
        : 'Select an arrangement to make it the default';
    btn.textContent = isDefault ? '★' : '☆';
    btn.setAttribute('aria-pressed', isDefault ? 'true' : 'false');
    btn.setAttribute('aria-label', label);
    btn.disabled = !name;
    btn.classList.toggle('text-yellow-300', isDefault);
    btn.classList.toggle('text-gray-400', !isDefault);
    btn.title = label;
}

async function pinCurrentArrangementDefault() {
    const name = _currentArrangementName();
    if (!name || name === _defaultArrangement) {
        syncDefaultArrangementPin();
        return;
    }
    const resp = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ default_arrangement: name }),
    });
    if (!resp.ok) return;
    _defaultArrangement = name;
    _syncDefaultArrangementSelect(name);
    syncDefaultArrangementPin();
}

// ── Highway String Colors (user theming) ──────────────────────────────────
// Colors are assigned per NAMED string (Low E, A, D, G, B, High E, plus the
// extended low strings of 7/8-string guitars), so a string keeps its color
// when the string count changes (e.g. Low E stays the same from a 6-string
// guitar to a 4-string bass, and on a 7-string the extra Low B takes the
// 7-string slot rather than bumping every color over). The highways color by
// raw string INDEX, so a small translation table maps named slots → per-index
// colors for the current arrangement; this is recomputed whenever a song loads
// (its string count / bass-vs-guitar may differ). Applies to BOTH the 2D and
// bundled 3D highway; stored client-side; shared via a copy/paste code.
const HWC_KEY_ACTIVE = 'highwayStringColors';    // JSON slot→hex map (active)
const HWC_KEY_THEMES = 'highwayColorThemes';     // { "<name>": {slot:hex} }
const HWC_KEY_NAME = 'highwayColorActiveName';   // selected saved theme name, or ''
const HWC_HEX_RE = /^#[0-9a-fA-F]{6}$/;

// Named color slots, in display order (high → low, then extended low strings).
const HWC_SLOTS = [
    { key: 'highE', label: 'High E', sub: '1st' },
    { key: 'B', label: 'B', sub: '2nd' },
    { key: 'G', label: 'G', sub: '3rd' },
    { key: 'D', label: 'D', sub: '4th' },
    { key: 'A', label: 'A', sub: '5th' },
    { key: 'lowE', label: 'Low E', sub: '6th / lowest' },
    { key: 'low7', label: 'Low B', sub: '7-string' },
    { key: 'low8', label: 'Low F#', sub: '8-string' },
];
const HWC_SLOT_KEYS = HWC_SLOTS.map((s) => s.key);
// Hardcoded fallback (matches the highway defaults) for before the 2D highway
// is queryable.
const HWC_DEFAULT_FALLBACK = { lowE: '#cc0000', A: '#cca800', D: '#0066cc', G: '#cc6600', B: '#00cc66', highE: '#9900cc', low7: '#cc00aa', low8: '#00cccc' };

// One-click string-color presets. Each is a full named-slot → hex map (every
// slot, so 7/8-string charts get a sensible color too) keyed by the same slot
// names as HWC_SLOTS, so "Low E" always lands on the lowE slot regardless of
// string count. Hues are chosen for the dark scene (~#080810): each color is
// bright enough to read on black and distinct from its neighbours.
//   - warmcool: an ordered low→high spectrum (warm reds at the bass end →
//     cool blues/violet at the treble end) so pitch reads as color temperature.
//   - vivid: punchier, higher-saturation take on the classic mapping for a
//     stage-bright look.
//   - colorblind: the Okabe–Ito accessible qualitative palette (vermillion,
//     orange, yellow, bluish-green, sky-blue, blue, reddish-purple), the most
//     distinguishable option for deuteranopia/protanopia.
//   - colorblind_deuteranope: a deuteranope-tuned variant of the Okabe–Ito set
//     above, contributed by a deuteranopic player who still found that set hard
//     to separate. Retunes the six main strings (red / yellow-green / blue /
//     orange / teal / deep-purple) and keeps its 7/8-string colors unchanged.
//   - neon: electric, max-saturation hues whose LIGHTNESS deliberately zig-zags
//     between neighbours (bright→bright→brightest→dark blue→bright green→dark
//     violet) so adjacent strings separate harder than vivid — a stage/stream
//     "pop" set, not a vivid duplicate.
//   - accessible: a CVD-safe set ORDERED by ascending lightness low→high (deep
//     blue → vermilion → azure → orange → yellow → cream). Unlike the unordered
//     Okabe–Ito 'colorblind' set, the value ramp teaches pitch low→high AND
//     survives grayscale/colorblindness; no red/green pair carries meaning.
//   - ember: a warm, lower-intensity family for long sessions, luminance-stepped
//     from rust/ember at the bass through warm gold to cream at the treble. The
//     bass embers stay light enough to clear the near-black scene.
//   - tapedeck: a vintage-print, slightly desaturated ochre-tinted family
//     (rust-red → mustard → avocado → teal → faded denim → dusty plum). Muted
//     hues collapse, so neighbour LIGHTNESS deliberately zig-zags to keep the
//     dusty mid-strings (avocado/teal/denim) distinct on the dark board.
//   - crtgreen / crtamber: monochrome CRT-phosphor families (green / amber)
//     stepped by STRICT ASCENDING LIGHTNESS low→high. Mono sets collapse on hue,
//     so lightness alone carries the ordering. Verified to stay legible even on
//     the matching phosphor scene board (green-on-green / amber-on-amber).
//   - pitchramp: a smooth low→high hue sweep (violet → blue → teal → green →
//     yellow → warm-white) with rising lightness — memorable + teaches order.
//   - sunrise: a soft dawn gradient (plum → rose → coral → amber → gold → cream),
//     warm and lower-intensity, lightness-stepped low→high.
const HWC_PRESETS = [
    {
        id: 'warmcool', label: 'Warm → Cool',
        colors: { lowE: '#ff3b30', A: '#ff7a18', D: '#ffc400', G: '#36c46a', B: '#2196f3', highE: '#9b5cff', low7: '#ff2d78', low8: '#00c2c7' },
    },
    {
        id: 'vivid', label: 'Vivid',
        colors: { lowE: '#ff2222', A: '#ffd000', D: '#1e8bff', G: '#ff7a00', B: '#16d65a', highE: '#b24bff', low7: '#ff3cc0', low8: '#15d8d8' },
    },
    {
        id: 'colorblind', label: 'Colorblind-friendly',
        colors: { lowE: '#d55e00', A: '#e69f00', D: '#f0e442', G: '#009e73', B: '#56b4e9', highE: '#cc79a7', low7: '#0072b2', low8: '#999999' },
    },
    {
        id: 'colorblind_deuteranope', label: 'Colorblind (deuteranope)',
        colors: { lowE: '#aa1414', A: '#88de00', D: '#1889e3', G: '#c6601c', B: '#00f5b2', highE: '#4d2173', low7: '#0072b2', low8: '#999999' },
    },
    {
        id: 'neon', label: 'Neon',
        colors: { lowE: '#ff1f4e', A: '#ff9d00', D: '#e9ff00', G: '#1844ff', B: '#00ff84', highE: '#d000ff', low7: '#ff00aa', low8: '#00f0ff' },
    },
    {
        id: 'accessible', label: 'Accessible (ordered)',
        colors: { lowE: '#2453c0', A: '#c44a00', D: '#3f93cf', G: '#ec9a1e', B: '#f2d43c', highE: '#f5eecb', low7: '#173f96', low8: '#0f2c6b' },
    },
    {
        id: 'ember', label: 'Warm Ember',
        colors: { lowE: '#c0392b', A: '#e0552a', D: '#ef7d2e', G: '#f6a13a', B: '#f4c95d', highE: '#f7e3a8', low7: '#9e2f23', low8: '#7d2418' },
    },
    {
        id: 'tapedeck', label: 'Tape Deck',
        colors: { lowE: '#b04632', A: '#d8ad42', D: '#5f7a34', G: '#54b3a6', B: '#5e83ad', highE: '#b98abb', low7: '#8f3526', low8: '#6f2a1e' },
    },
    {
        id: 'crtgreen', label: 'CRT Green',
        colors: { lowE: '#0a5a23', A: '#108a30', D: '#1fb53f', G: '#3ad94f', B: '#74f06a', highE: '#c7ffb0', low7: '#08491c', low8: '#063514' },
    },
    {
        id: 'crtamber', label: 'CRT Amber',
        colors: { lowE: '#7a3a02', A: '#a85f06', D: '#cf8410', G: '#e8a82a', B: '#f4cf5e', highE: '#ffeeb8', low7: '#5f2d01', low8: '#471f00' },
    },
    {
        id: 'pitchramp', label: 'Pitch Ramp',
        colors: { lowE: '#7a2390', A: '#2f5ad8', D: '#1f9bc4', G: '#2fb84a', B: '#cfd22a', highE: '#f3e0c0', low7: '#5e1a78', low8: '#440f5e' },
    },
    {
        id: 'sunrise', label: 'Sunrise',
        colors: { lowE: '#8a3a6e', A: '#bf4a5e', D: '#e0664f', G: '#f29a55', B: '#f7c873', highE: '#fce8b8', low7: '#6e2c5c', low8: '#54214a' },
    },
];

// Translation table: chart string index → named slot, for a given string count
// and bass/guitar family. Mirrors the 3D highway's _baseOpenStringMidis: bass
// shares the low strings (E A D G), 7/8-string guitars prepend lower strings,
// and sub-6 guitars truncate from the high end. Index 0 is always the lowest.
function _hwcSlotKeysForChart(sc, isBass) {
    sc = Math.max(1, Math.min(8, (sc | 0) || 6));
    if (isBass) {
        if (sc <= 4) return ['lowE', 'A', 'D', 'G'].slice(0, sc);
        if (sc === 5) return ['low7', 'lowE', 'A', 'D', 'G'];
        return ['low8', 'low7', 'lowE', 'A', 'D', 'G'].slice(0, sc);
    }
    if (sc <= 6) return ['lowE', 'A', 'D', 'G', 'B', 'highE'].slice(0, sc);
    if (sc === 7) return ['low7', 'lowE', 'A', 'D', 'G', 'B', 'highE'];
    return ['low8', 'low7', 'lowE', 'A', 'D', 'G', 'B', 'highE'];
}

// Current arrangement shape (string count + bass-vs-guitar) from the 2D highway.
function _hwcChartShape() {
    let sc = 6, arr = '';
    try { sc = window.highway?.getStringCount?.() || 6; } catch (_) {}
    try { arr = window.highway?.getSongInfo?.()?.arrangement || window.feedBack?.currentSong?.arrangement || ''; } catch (_) {}
    return { sc: Math.max(1, Math.min(8, sc)), isBass: /bass/i.test(String(arr)) };
}

// Normalize an arbitrary value to a slot→hex map of validated lowercase colors
// (absent / invalid slots are omitted).
function _hwcNormalize(slotMap) {
    const out = {};
    if (slotMap && typeof slotMap === 'object' && !Array.isArray(slotMap)) {
        for (const k of HWC_SLOT_KEYS) {
            const v = (typeof slotMap[k] === 'string') ? slotMap[k].trim().toLowerCase() : '';
            if (HWC_HEX_RE.test(v)) out[k] = v;
        }
    }
    return out;
}

// Canonical default color per named slot (the classic highway mapping).
// Fixed, not read back from the highway (which may already be name-remapped for
// a 7/8-string chart), so the pickers always preview the true per-name default.
function getHighwayDefaultSlotColors() {
    return { ...HWC_DEFAULT_FALLBACK };
}

// Active (user-customized) slot→hex map from storage ({} when none set).
function getHighwayStringColors() {
    try {
        const raw = localStorage.getItem(HWC_KEY_ACTIVE);
        if (raw) return _hwcNormalize(JSON.parse(raw));
    } catch (_) { /* corrupt / blocked */ }
    return {};
}

// Defaults overlaid with the user's custom slots (custom wins). Always a full
// 8-slot map, so name-mapping has a color for every string of any arrangement.
function _hwcMergedSlotColors() {
    return { ...getHighwayDefaultSlotColors(), ...getHighwayStringColors() };
}

// True when the slot→index mapping is the identity (index 0 = lowest = Low E):
// guitar ≤6 strings and 4-string bass. For these the name mapping equals the
// stock index order, so we leave the highways on their hand-tuned defaults
// (byte-identical) unless the user set custom colors. Extended-range charts —
// 7/8-string guitar and 5/6-string bass — prepend lower strings (Low B/F#),
// shifting Low E up an index, so their defaults must be name-remapped too.
function _hwcMappingIsIdentity(sc, isBass) {
    return isBass ? sc <= 4 : sc <= 6;
}

// Translate a full slot map into the index-keyed array the highways consume.
function _hwcEffectiveIndexColors(slotMap, sc, isBass) {
    const keys = _hwcSlotKeysForChart(sc, isBass);
    return keys.map((k) => slotMap[k] || null);
}

// Persist the user's custom slot map (or clear it), then apply. Only slots that
// actually DIFFER from the default are stored — so reverting every picker to its
// stock color persists as empty and the identity/stock path is restored (rather
// than pinning the highways on an all-default "custom" theme).
function applyHighwayStringColors(slotMap, opts) {
    const persist = !opts || opts.persist !== false;
    const colors = _hwcNormalize(slotMap);
    const defaults = getHighwayDefaultSlotColors();
    const overrides = {};
    for (const k of Object.keys(colors)) {
        if (colors[k] !== defaults[k]) overrides[k] = colors[k];
    }
    if (persist) {
        try {
            if (Object.keys(overrides).length) localStorage.setItem(HWC_KEY_ACTIVE, JSON.stringify(overrides));
            else localStorage.removeItem(HWC_KEY_ACTIVE);
        } catch (_) {}
    }
    reapplyHighwayStringColors();
}

// Apply a named one-click string-color preset (see HWC_PRESETS) to all strings.
// Persists + applies to both highways (via applyHighwayStringColors), then —
// when the Settings UI is mounted — refreshes the per-string pickers so their
// swatches show the preset's colors. Unknown id is a no-op.
function applyHighwayStringPreset(id) {
    const preset = HWC_PRESETS.find((p) => p.id === id);
    if (!preset) return false;
    applyHighwayStringColors(preset.colors);
    try { if (typeof hwcRenderPickers === 'function') hwcRenderPickers(); } catch (_) {}
    return true;
}

// Apply colors by NAMED string to both highways for the current arrangement.
// Colors follow the string name regardless of count: Low E stays Low E's color
// on a 6-, 7-, or 8-string. Defaults map identically to the stock order for
// 6-string/bass (so those stay byte-identical); 7/8-string remaps the defaults
// too so Low E keeps its color. The String Colors UI replaces the 3D highway's
// old palette picker, so core always drives the 3D string colors here.
function reapplyHighwayStringColors() {
    const { sc, isBass } = _hwcChartShape();
    const custom = getHighwayStringColors();
    const hasCustom = Object.keys(custom).length > 0;

    if (!hasCustom && _hwcMappingIsIdentity(sc, isBass)) {
        // Pure stock defaults in natural order — leave the hand-tuned highway
        // defaults intact, and make sure the 3D is on its plain default palette
        // (clears any stale 'custom' / leftover palette selection).
        try { window.highway?.setStringColors?.(null); } catch (_) {}
        try {
            if (localStorage.getItem('h3d_bg_palette') !== 'default') window.h3dBgSetPalette?.('default');
        } catch (_) {}
        try { window.feedBack?.emit?.('highway:stringColors', {}); } catch (_) {}
        return;
    }

    const eff = _hwcEffectiveIndexColors(_hwcMergedSlotColors(), sc, isBass);
    try { window.highway?.setStringColors?.(eff); } catch (_) {}
    try { window.h3dBgSetStringColors?.(eff); } catch (_) {}
    try { window.feedBack?.emit?.('highway:stringColors', custom); } catch (_) {}
}

function _hwcReadThemes() {
    // Null-prototype store: theme names come from user input / share codes, so
    // names like `constructor`/`toString`/`__proto__` must not collide with
    // inherited Object properties or mutate the prototype.
    try {
        const parsed = JSON.parse(localStorage.getItem(HWC_KEY_THEMES) || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return Object.create(null);
        const out = Object.create(null);
        for (const [name, colors] of Object.entries(parsed)) out[name] = _hwcNormalize(colors);
        return out;
    } catch (_) { return Object.create(null); }
}
function _hwcWriteThemes(o) { try { localStorage.setItem(HWC_KEY_THEMES, JSON.stringify(o)); } catch (_) {} }
function listHighwayColorThemes() { return Object.keys(_hwcReadThemes()); }
function getActiveHighwayColorThemeName() { try { return localStorage.getItem(HWC_KEY_NAME) || ''; } catch (_) { return ''; } }

function saveHighwayColorTheme(name, slotMap) {
    name = String(name || '').trim();
    if (!name) return false;
    const o = _hwcReadThemes();
    o[name] = _hwcNormalize(slotMap);
    _hwcWriteThemes(o);
    try { localStorage.setItem(HWC_KEY_NAME, name); } catch (_) {}
    return true;
}
function deleteHighwayColorTheme(name) {
    const o = _hwcReadThemes();
    if (Object.prototype.hasOwnProperty.call(o, name)) { delete o[name]; _hwcWriteThemes(o); }
    if (getActiveHighwayColorThemeName() === name) { try { localStorage.removeItem(HWC_KEY_NAME); } catch (_) {} }
}
// Select a saved theme by name, or pass '' to revert to defaults.
function selectHighwayColorTheme(name) {
    if (!name) {
        try { localStorage.removeItem(HWC_KEY_NAME); } catch (_) {}
        applyHighwayStringColors(null);
        return;
    }
    const o = _hwcReadThemes();
    if (!Object.prototype.hasOwnProperty.call(o, name)) return;
    try { localStorage.setItem(HWC_KEY_NAME, name); } catch (_) {}
    applyHighwayStringColors(o[name]);
}

// Compact, paste-friendly share code: "SLOPHWY2." + base64url(JSON{n,c}) where
// c is the named slot→hex map.
function encodeHighwayColorShare(name, slotMap) {
    const payload = { n: String(name || '').slice(0, 60), c: _hwcNormalize(slotMap) };
    const json = JSON.stringify(payload);
    let b64;
    try { b64 = btoa(unescape(encodeURIComponent(json))); } catch (_) { b64 = btoa(json); }
    return 'SLOPHWY2.' + b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeHighwayColorShare(code) {
    if (typeof code !== 'string') return null;
    let s = code.trim();
    // Require the exact versioned prefix. Anything else (a future/legacy
    // SLOPHWY*, or unprefixed text) is rejected so the version boundary is real.
    const PREFIX = 'SLOPHWY2.';
    if (s.slice(0, PREFIX.length).toUpperCase() !== PREFIX) return null;
    s = s.slice(PREFIX.length);
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    let json;
    try { json = decodeURIComponent(escape(atob(s))); } catch (_) { try { json = atob(s); } catch (_) { return null; } }
    let obj;
    try { obj = JSON.parse(json); } catch (_) { return null; }
    if (!obj || typeof obj.c !== 'object' || Array.isArray(obj.c)) return null;
    return { name: String(obj.n || '').slice(0, 60), colors: _hwcNormalize(obj.c) };
}
// Import a share code: store it as a (uniquely named) saved theme and apply.
function importHighwayColorShare(code) {
    const parsed = decodeHighwayColorShare(code);
    if (!parsed) return null;
    let name = parsed.name || 'Imported';
    const existing = _hwcReadThemes();
    if (Object.prototype.hasOwnProperty.call(existing, name)) {
        let i = 2;
        while (Object.prototype.hasOwnProperty.call(existing, name + ' ' + i)) i++;
        name = name + ' ' + i;
    }
    saveHighwayColorTheme(name, parsed.colors);
    applyHighwayStringColors(parsed.colors);
    return { name, colors: parsed.colors };
}

// Startup: apply persisted colors to the 2D highway immediately and re-apply on
// every song load (string count / bass-vs-guitar can change the slot→index
// mapping) and whenever a viz renderer (re)initializes (the 3D loads async +
// rebuilds per song, so a one-shot apply could land before it exists).
let _hwcWired = false;
function initHighwayColors() {
    reapplyHighwayStringColors();
    if (!_hwcWired && window.feedBack && typeof window.feedBack.on === 'function') {
        _hwcWired = true;
        window.feedBack.on('viz:renderer:ready', reapplyHighwayStringColors);
        window.feedBack.on('song:loaded', reapplyHighwayStringColors);
        window.feedBack.on('song:ready', reapplyHighwayStringColors);
    }
    _hwcInstallFacade();
}

// ── Public plugin API: window.feedBack.highwayColors ─────────────────────
// A stable, documented facade over the (otherwise private) string-color
// manager so plugins can read / react to / set the user's per-string colors
// without reaching into internals. This is a synchronous data-plane API, not a
// capability domain — consistent with the constitution keeping highway/viz
// surfaces off the capability graph until a dedicated render-facade slice
// lands. Colors are keyed by NAMED string slot (see `slots`); use
// `keysForChart`/`toEffective` to map names → per-string-index for a given
// arrangement. See docs/plugin-capability-inventory.md.
const _hwcChangeWrappers = new WeakMap();
function _hwcInstallFacade() {
    if (!window.feedBack || window.feedBack.highwayColors) return;
    const api = {
        version: 1,
        // Ordered named slots: [{ key, label, sub }]. `key` is the stable id.
        slots: HWC_SLOTS.map((s) => ({ key: s.key, label: s.label, sub: s.sub })),
        // User-set overrides only (named slot → hex); empty object = defaults.
        get() { return getHighwayStringColors(); },
        // Canonical default color per named slot.
        getDefaults() { return getHighwayDefaultSlotColors(); },
        // Defaults overlaid with overrides — the colors in effect, by name.
        getResolved() { return _hwcMergedSlotColors(); },
        // Which named slot each chart string index maps to, for an arrangement
        // (index 0 = lowest string). e.g. (7,false) → ['low7','lowE','A',...].
        keysForChart(stringCount, isBass) { return _hwcSlotKeysForChart(stringCount, !!isBass); },
        // Per-string-INDEX hex array (resolved colors) for an arrangement.
        // Omit args to use the currently-loaded chart's shape.
        toEffective(stringCount, isBass) {
            const shape = (typeof stringCount === 'number')
                ? { sc: stringCount, isBass: !!isBass }
                : _hwcChartShape();
            return _hwcEffectiveIndexColors(_hwcMergedSlotColors(), shape.sc, shape.isBass);
        },
        // The per-index colors actually applied to the live 2D highway now.
        getCurrent() {
            try { return (window.highway && window.highway.getStringColors) ? window.highway.getStringColors() : []; }
            catch (_) { return []; }
        },
        // Set colors programmatically (persists + applies to both highways).
        // Pass a named slot map, or null/{} to revert to defaults.
        apply(slotMap) { return applyHighwayStringColors(slotMap); },
        // One-click presets: [{ id, label, colors }] (full named-slot maps).
        presets: HWC_PRESETS.map((p) => ({ id: p.id, label: p.label, colors: { ...p.colors } })),
        // Apply a preset by id (persists + applies to both highways).
        applyPreset(id) { return applyHighwayStringPreset(id); },
        // Share-code interop (the "SLOPHWY2." copy/paste format).
        encodeShare(name, slotMap) { return encodeHighwayColorShare(name, slotMap); },
        decodeShare(code) { return decodeHighwayColorShare(code); },
        // Subscribe to color changes; handler receives the resolved slot map.
        // Returns an unsubscribe fn that removes exactly THIS subscription;
        // offChange(fn) removes every subscription registered with that fn.
        // (Each fn maps to a Set of wrappers so repeated mount/init paths that
        // subscribe the same handler don't clobber each other or leak.)
        onChange(fn) {
            if (typeof fn !== 'function' || !window.feedBack) return () => {};
            const wrapper = () => {
                try { fn(api.getResolved()); } catch (e) { console.error('[highwayColors] onChange handler threw', e); }
            };
            let set = _hwcChangeWrappers.get(fn);
            if (!set) { set = new Set(); _hwcChangeWrappers.set(fn, set); }
            set.add(wrapper);
            window.feedBack.on('highway:stringColors', wrapper);
            return () => {
                if (window.feedBack) window.feedBack.off('highway:stringColors', wrapper);
                const s = _hwcChangeWrappers.get(fn);
                if (s) { s.delete(wrapper); if (!s.size) _hwcChangeWrappers.delete(fn); }
            };
        },
        offChange(fn) {
            const set = _hwcChangeWrappers.get(fn);
            if (set && window.feedBack) {
                for (const wrapper of set) window.feedBack.off('highway:stringColors', wrapper);
                _hwcChangeWrappers.delete(fn);
            }
        },
    };
    window.feedBack.highwayColors = api;
}

// ── Highway String Colors — Settings UI wiring ───────────────────────────
// Pickers are per NAMED string (see HWC_SLOTS). Assigning "Low E" a color
// keeps Low E that color regardless of string count — the translation table
// (_hwcSlotKeysForChart) handles the index remapping per arrangement.

function _hwcStatus(msg) {
    const el = document.getElementById('hwc-status');
    if (!el) return;
    el.textContent = msg || '';
    if (msg) {
        clearTimeout(_hwcStatus._t);
        _hwcStatus._t = setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 2500);
    }
}

// Render one color input per named slot, seeded from active colors (falling
// back to the highway defaults for that slot).
function hwcRenderPickers() {
    const host = document.getElementById('hwc-pickers');
    if (!host) return;
    const defaults = getHighwayDefaultSlotColors();
    const active = getHighwayStringColors();
    host.innerHTML = '';
    for (const slot of HWC_SLOTS) {
        const val = active[slot.key] || defaults[slot.key] || '#888888';
        const wrap = document.createElement('label');
        wrap.className = 'flex items-center gap-2 text-xs text-gray-400';
        const input = document.createElement('input');
        input.type = 'color';
        input.id = 'hwc-color-' + slot.key;
        input.dataset.slot = slot.key;
        input.value = val;
        input.style.width = '2.5rem';
        input.style.height = '1.75rem';
        input.style.padding = '2px';
        input.style.cursor = 'pointer';
        input.className = 'rounded border border-gray-800 bg-dark-700';
        input.addEventListener('input', () => hwcOnColorInput());
        wrap.appendChild(input);
        const span = document.createElement('span');
        span.textContent = slot.label;
        wrap.appendChild(span);
        const sub = document.createElement('span');
        sub.className = 'text-gray-600';
        sub.textContent = slot.sub;
        wrap.appendChild(sub);
        host.appendChild(wrap);
    }
}

function hwcReadPickers() {
    const out = {};
    for (const slot of HWC_SLOTS) {
        const el = document.getElementById('hwc-color-' + slot.key);
        if (el) out[slot.key] = el.value;
    }
    return out;
}

// Live apply on any picker change. Leaves the saved-theme select alone so a
// tweaked-but-unsaved state is allowed; "Save as…" captures it.
function hwcOnColorInput() {
    applyHighwayStringColors(hwcReadPickers());
}

function hwcPopulateThemeSelect() {
    const sel = document.getElementById('hwc-theme-select');
    if (!sel) return;
    const names = listHighwayColorThemes().sort((a, b) => a.localeCompare(b));
    const current = getActiveHighwayColorThemeName();
    sel.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = 'Default colors';
    sel.appendChild(def);
    for (const n of names) {
        const opt = document.createElement('option');
        opt.value = n;
        opt.textContent = n;
        sel.appendChild(opt);
    }
    sel.value = (current && names.includes(current)) ? current : '';
}

function hwcOnSelectTheme(name) {
    selectHighwayColorTheme(name);
    hwcRenderPickers();
}

async function hwcSaveTheme() {
    const name = await uiPrompt({ title: 'Save Highway Colors', label: 'Theme name', value: getActiveHighwayColorThemeName() || 'My Colors', okLabel: 'Save' });
    if (!name) return;
    saveHighwayColorTheme(name, hwcReadPickers());
    hwcPopulateThemeSelect();
    _hwcStatus('Saved “' + name + '”');
}

function hwcDeleteTheme() {
    const name = getActiveHighwayColorThemeName();
    if (!name) { _hwcStatus('No saved theme selected'); return; }
    deleteHighwayColorTheme(name);
    applyHighwayStringColors(null);
    hwcPopulateThemeSelect();
    hwcRenderPickers();
    _hwcStatus('Deleted “' + name + '”');
}

function hwcReset() {
    try { localStorage.removeItem(HWC_KEY_NAME); } catch (_) {}
    applyHighwayStringColors(null);
    hwcPopulateThemeSelect();
    hwcRenderPickers();
    _hwcStatus('Reset to defaults');
}

async function hwcCopyShare() {
    const name = getActiveHighwayColorThemeName() || 'Highway Colors';
    const code = encodeHighwayColorShare(name, hwcReadPickers());
    let copied = false;
    try { await navigator.clipboard.writeText(code); copied = true; } catch (_) {}
    if (!copied) {
        // Fallback: drop the code into the import field so it can be copied manually.
        const inp = document.getElementById('hwc-import-code');
        if (inp) { inp.value = code; inp.select(); }
    }
    _hwcStatus(copied ? 'Share code copied' : 'Copy failed — code shown below');
}

function hwcImport() {
    const inp = document.getElementById('hwc-import-code');
    const code = inp ? inp.value : '';
    const res = importHighwayColorShare(code);
    if (!res) { _hwcStatus('Invalid share code'); return; }
    if (inp) inp.value = '';
    hwcPopulateThemeSelect();
    hwcRenderPickers();
    _hwcStatus('Imported “' + res.name + '”');
}

function hwcInitSettingsUI() {
    hwcPopulateThemeSelect();
    hwcRenderPickers();
}

async function loadSettings() {
    // App Updates UI does not depend on /api/settings — run it first so a
    // failed fetch below still leaves the desktop updater wired up.
    // setupAppUpdates() is idempotent via _appUpdatesWired.
    setupAppUpdates();
    const resp = await fetch('/api/settings');
    const data = await resp.json();
    // Null-guard the form fields: on the v3 tabbed settings page the markup is
    // rendered by settings.js, so a control may be absent if that render hasn't
    // run yet (or on a follower window). The optional-chaining keeps loadSettings
    // from throwing and aborting the rest of the hydration.
    const dlcEl = document.getElementById('dlc-path');
    if (dlcEl) dlcEl.value = data.dlc_dir || '';
    _defaultArrangement = data.default_arrangement || '';
    _syncDefaultArrangementSelect(_defaultArrangement);
    const pathwayEl = document.getElementById('setting-instrument-pathway');
    if (pathwayEl) pathwayEl.value = _normalizeInstrumentPathway(data.pathway);
    const demucsEl = document.getElementById('demucs-server-url');
    if (demucsEl) demucsEl.value = data.demucs_server_url || '';
    const leftyEl = document.getElementById('setting-lefty');
    if (leftyEl) leftyEl.checked = highway.getLefty();
    const autoplayExitEl = document.getElementById('setting-autoplay-exit');
    if (autoplayExitEl) autoplayExitEl.checked = _autoplayExitEnabled();
    const showUpNextEl = document.getElementById('setting-show-upnext');
    if (showUpNextEl) showUpNextEl.checked = _showUpNextEnabled();
    const confirmExitEl = document.getElementById('setting-confirm-exit');
    if (confirmExitEl) confirmExitEl.checked = _exitConfirmEnabled();
    // Restore master-difficulty slider from persisted value (defaults
    // to 100 when the key is absent — no behaviour change for users
    // who've never touched the slider).
    const masteryPct = typeof data.master_difficulty === 'number'
        ? Math.max(0, Math.min(100, data.master_difficulty))
        : 100;
    // Drives both the player-popover slider (#mastery-slider) and the
    // Gameplay-tab "Note highway speed" slider (#setting-highway-speed), which
    // share the master_difficulty key. skipPersist so loading the value doesn't
    // echo it back to the server.
    _applyMastery(masteryPct, { skipPersist: true });
    // Route the loaded value through setAvOffsetMs so the highway's
    // render clock, the Settings slider, the HUD readout, and the
    // module variable all pick it up consistently. Pass skipPersist
    // so we don't echo the loaded value back to the server.
    setAvOffsetMs(Number(data.av_offset_ms) || 0, /* skipPersist */ true);
    // Arrangement naming mode is localStorage-only (client preference).
    const namingModeEl = document.getElementById('arrangement-naming-mode');
    if (namingModeEl) namingModeEl.value = _getArrangementNamingMode();
    // Gameplay-tab settings (tabbed settings page). Countdown is mirrored to
    // localStorage so the song-start path reads it synchronously without an
    // async /api/settings fetch on the play hot path. Miss penalty / fail
    // behavior are persist-only stubs (not yet consumed by scoring).
    const countdownOn = data.countdown_before_song === true;
    try { localStorage.setItem('countdownBeforeSong', countdownOn ? '1' : '0'); } catch (_) { /* private mode */ }
    const countdownEl = document.getElementById('setting-countdown-before-song');
    if (countdownEl) countdownEl.checked = countdownOn;
    // Achievements epic: mirror the opt-in flag to localStorage so the
    // onboarding card + the bundled achievements plugin can read the current
    // state app-wide (the plugin's own settings panel still owns the toggle).
    try { localStorage.setItem('achievementsEnabled', data.achievements_enabled === true ? '1' : '0'); } catch (_) { /* private mode */ }
    const missEl = document.getElementById('setting-miss-penalty');
    if (missEl) missEl.value = typeof data.miss_penalty === 'string' ? data.miss_penalty : 'none';
    const failEl = document.getElementById('setting-fail-behavior');
    if (failEl) failEl.value = typeof data.fail_behavior === 'string' ? data.fail_behavior : 'continue';
    // Native folder picker — only present when running inside feedBack-desktop.
    if (window.feedBackDesktop && typeof window.feedBackDesktop.pickDirectory === 'function') {
        document.getElementById('btn-pick-dlc')?.classList.remove('hidden');
    }
    syncDefaultArrangementPin();
    // Hydrate the highway-color settings UI (theme select + per-string pickers)
    // — the runtime apply path (initHighwayColors) doesn't render these controls.
    hwcInitSettingsUI();
}

// ── App Updates (desktop-only) ───────────────────────────────────────────
// Velopack auto-update controls, rendered as the first block of the Settings
// page. Whole block stays hidden in the plain web app; unhide + wire only
// when the feedBack-desktop bridge (window.feedBackDesktop.update) is
// present. On Linux the block renders but its controls are disabled — the
// desktop reports platform === 'linux' and short-circuits the IPC.

const APP_UPDATE_CHANNELS = ['stable', 'rc', 'beta', 'alpha'];
let _appUpdatesWired = false;

function setupAppUpdates() {
    const block = document.getElementById('app-updates-block');
    if (!block) return;
    const updateApi = window.feedBackDesktop?.update;
    // Per-method capability check: an older or partial feedBack-desktop
    // bridge may expose `update` without the full shape. Skip wiring (and
    // leave the block hidden) rather than throwing on first interaction.
    if (!updateApi
        || typeof updateApi.getStatus !== 'function'
        || typeof updateApi.setChannel !== 'function'
        || typeof updateApi.checkNow !== 'function') {
        return;
    }

    block.classList.remove('hidden');

    const channelSelect = document.getElementById('app-update-channel');
    const checkBtn = document.getElementById('app-update-check-now');
    const statusEl = document.getElementById('app-update-status');
    const linuxNote = document.getElementById('app-update-linux-note');
    if (!channelSelect || !checkBtn || !statusEl) return;

    // localStorage access can throw in storage-restricted contexts (sandbox
    // iframes, privacy modes, etc.); fall back to the default channel so the
    // panel still renders rather than aborting wiring entirely.
    let storedRaw = null;
    // Read the canonical key, falling back to the pre-rename
    // 'slopsmith-update-channel' so an existing channel preference survives.
    try { storedRaw = localStorage.getItem('feedBack-update-channel') || localStorage.getItem('slopsmith-update-channel'); } catch (_) { /* fall through */ }
    const stored = APP_UPDATE_CHANNELS.includes(storedRaw) ? storedRaw : 'stable';
    channelSelect.value = stored;

    const isLinux = window.feedBackDesktop?.platform === 'linux';

    function showLinuxFallback(message) {
        if (linuxNote) linuxNote.classList.remove('hidden');
        channelSelect.disabled = true;
        checkBtn.disabled = true;
        statusEl.textContent = message || 'Auto-update is not available on this platform.';
    }

    function fmtTimestamp(ts) {
        if (!ts) return 'never';
        try {
            const d = new Date(ts);
            return Number.isNaN(d.getTime()) ? 'never' : d.toLocaleString();
        } catch (_) { return 'never'; }
    }

    function renderStatus(extra) {
        try {
            // Wrap in Promise.resolve so a future getStatus() that returns
            // synchronously won't blow up on .then().
            void Promise.resolve(updateApi.getStatus()).then((s) => {
                if (!s) { statusEl.textContent = extra || 'Updater status unavailable.'; return; }
                if (s.status === 'unsupported' || s.platform === 'linux') {
                    showLinuxFallback('Auto-update is not available on Linux.');
                    return;
                }
                if (s.status === 'error') {
                    const errMsg = s.message ? `Update error: ${s.message}` : 'Update check failed.';
                    statusEl.textContent = extra ? `${extra} · ${errMsg}` : errMsg;
                    return;
                }
                const parts = [
                    `Version ${s.currentVersion || '?'}`,
                    `channel ${s.channel || channelSelect.value}`,
                    `last checked ${fmtTimestamp(s.lastChecked)}`,
                ];
                statusEl.textContent = extra ? `${extra} · ${parts.join(' · ')}` : parts.join(' · ');
            }).catch((e) => {
                console.warn('[updater] getStatus failed:', e);
                statusEl.textContent = extra || 'Failed to read updater status.';
            });
        } catch (e) {
            console.warn('[updater] getStatus threw:', e);
            statusEl.textContent = extra || 'Failed to read updater status.';
        }
    }

    if (isLinux) {
        showLinuxFallback('Auto-update is not available on Linux.');
        // Keep main informed of the persisted channel even on Linux so
        // cross-platform reasoning about the channel stays consistent.
        // setChannel() may return a Promise — chain .catch() so a rejected
        // promise doesn't surface as an unhandled rejection.
        try {
            void Promise.resolve(updateApi.setChannel(stored)).catch((e) => {
                console.warn('[updater] setChannel(linux) failed:', e);
            });
        } catch (e) {
            console.warn('[updater] setChannel(linux) threw:', e);
        }
        return;
    }

    // Inform main of the persisted channel on each load. setChannel() on
    // main is idempotent when the channel already matches.
    try {
        void Promise.resolve(updateApi.setChannel(stored)).catch((e) => {
            console.warn('[updater] setChannel(initial) failed:', e);
        });
    } catch (e) {
        console.warn('[updater] setChannel(initial) threw:', e);
    }

    if (!_appUpdatesWired) {
        // Wire DOM listeners once. The elements live in static index.html
        // and are not recreated, so re-wiring on every loadSettings() call
        // would just stack duplicate handlers.
        channelSelect.addEventListener('change', async () => {
            const val = channelSelect.value;
            if (!APP_UPDATE_CHANNELS.includes(val)) return;
            try { localStorage.setItem('feedBack-update-channel', val); localStorage.removeItem('slopsmith-update-channel'); } catch (_) {}
            try {
                // Await setChannel so the status line reflects what actually
                // happened — rendering "Channel set" unconditionally would
                // mislead users when the IPC rejects.
                await Promise.resolve(updateApi.setChannel(val));
                renderStatus(`Channel set to ${val}.`);
            } catch (e) {
                console.warn('[updater] setChannel failed:', e);
                renderStatus(`Failed to set channel to ${val}: ${e?.message || e}`);
            }
        });

        checkBtn.addEventListener('click', async () => {
            checkBtn.disabled = true;
            statusEl.textContent = 'Checking for updates…';
            let reEnableBtn = true;
            try {
                const result = await updateApi.checkNow();
                const status = result?.status || 'unknown';
                let msg;
                switch (status) {
                    case 'idle':
                        msg = "You're on the newest version in this channel.";
                        break;
                    case 'downloading':
                        msg = 'Update available — downloading…';
                        break;
                    case 'downloaded':
                        msg = 'Update downloaded — restart to apply.';
                        break;
                    case 'unsupported':
                        reEnableBtn = false;
                        showLinuxFallback('Auto-update is not available on Linux.');
                        return;
                    case 'error':
                        msg = `Update check failed${result?.message ? `: ${result.message}` : '.'}`;
                        break;
                    default:
                        msg = `Update check returned: ${status}`;
                }
                renderStatus(msg);
            } catch (e) {
                console.warn('[updater] checkNow failed:', e);
                statusEl.textContent = `Update check failed: ${e?.message || e}`;
            } finally {
                if (reEnableBtn) checkBtn.disabled = false;
            }
        });

        _appUpdatesWired = true;
    }

    renderStatus();
}

// ── Restart banner (desktop-only) ────────────────────────────────────────
// Subscribes to window.feedBackDesktop.update.onDownloaded and renders a
// persistent banner with a "Restart now" button. Runs once at app boot so a
// download finishing while the user is on a non-Settings screen still pops
// the banner.

function initAppUpdateBanner() {
    const updateApi = window.feedBackDesktop?.update;
    // Same capability gate as setupAppUpdates — the banner needs onDownloaded
    // to subscribe, getStatus to detect pre-existing pending updates on boot,
    // and apply to actually restart from the button. A bridge missing any
    // of these would partially fail; better to no-op cleanly.
    if (!updateApi
        || typeof updateApi.onDownloaded !== 'function'
        || typeof updateApi.getStatus !== 'function'
        || typeof updateApi.apply !== 'function') {
        return;
    }

    const BANNER_ID = 'feedBack-update-banner';

    function renderUpdateBanner(payload) {
        // Avoid stacking duplicate banners if onDownloaded fires more than once.
        if (document.getElementById(BANNER_ID)) return;

        const banner = document.createElement('div');
        banner.id = BANNER_ID;
        banner.setAttribute('role', 'status');
        banner.style.cssText = [
            'position:fixed', 'top:0', 'left:0', 'right:0',
            'z-index:99999', 'padding:10px 16px',
            'background:linear-gradient(90deg,#1e3a8a,#4338ca)',
            'color:#fff', 'font-size:13px',
            'font-family:system-ui,sans-serif',
            'display:flex', 'align-items:center', 'justify-content:space-between',
            'gap:12px', 'box-shadow:0 2px 8px rgba(0,0,0,0.4)',
        ].join(';');

        const text = document.createElement('span');
        const version = payload && payload.version ? ` (${payload.version})` : '';
        text.textContent = `Update downloaded${version} — restart to apply.`;

        const actions = document.createElement('span');
        actions.style.cssText = 'display:flex;gap:8px;align-items:center';

        const restartBtn = document.createElement('button');
        restartBtn.textContent = 'Restart now';
        restartBtn.style.cssText = [
            'padding:4px 12px', 'border-radius:4px',
            'background:#fff', 'color:#1e3a8a', 'border:none',
            'font-weight:600', 'cursor:pointer', 'font-size:13px',
        ].join(';');
        restartBtn.addEventListener('click', async () => {
            restartBtn.disabled = true;
            restartBtn.textContent = 'Restarting…';
            try {
                // apply() can resolve with { status: 'error' } instead of
                // throwing; only re-enable the button on that path.
                const result = await updateApi.apply();
                if (result?.status === 'error') {
                    console.warn('[updater] apply returned error:', result.message || 'unknown');
                    restartBtn.disabled = false;
                    restartBtn.textContent = 'Restart now';
                }
            } catch (e) {
                console.warn('[updater] apply failed:', e);
                restartBtn.disabled = false;
                restartBtn.textContent = 'Restart now';
            }
        });

        const dismissBtn = document.createElement('button');
        dismissBtn.textContent = 'Later';
        dismissBtn.setAttribute('aria-label', 'Dismiss update banner');
        dismissBtn.style.cssText = [
            'padding:4px 10px', 'border-radius:4px',
            'background:transparent', 'color:#fff',
            'border:1px solid rgba(255,255,255,0.3)',
            'cursor:pointer', 'font-size:13px',
        ].join(';');
        dismissBtn.addEventListener('click', () => banner.remove());

        actions.appendChild(restartBtn);
        actions.appendChild(dismissBtn);
        banner.appendChild(text);
        banner.appendChild(actions);

        const insert = () => {
            if (document.body) document.body.appendChild(banner);
            else document.addEventListener('DOMContentLoaded', () => document.body.appendChild(banner), { once: true });
        };
        insert();
    }

    try {
        updateApi.onDownloaded((payload) => {
            try { renderUpdateBanner(payload); }
            catch (e) { console.warn('[updater] renderUpdateBanner failed:', e); }
        });
    } catch (e) {
        console.warn('[updater] onDownloaded subscribe failed:', e);
    }

    // Catch pre-existing pending updates (downloaded in a previous session,
    // or restored on launch). onDownloaded only fires for downloads that
    // complete in the current session, so do an explicit status check too.
    try {
        void Promise.resolve(updateApi.getStatus()).then((status) => {
            // Render the banner for any 'downloaded' status; the version
            // string is best-effort — renderUpdateBanner() already drops the
            // "(vX.Y.Z)" suffix when none is supplied, so an update reported
            // without pending.version still surfaces the restart prompt.
            if (status && status.status === 'downloaded') {
                renderUpdateBanner({ version: status.pending?.version, channel: status.channel });
            }
        }).catch((e) => {
            console.warn('[updater] getStatus on init failed:', e);
        });
    } catch (e) {
        console.warn('[updater] getStatus on init threw:', e);
    }
}

// Updates the fill on slider elements. Expects a CSS variable --range-pct used
// in the track fill styling. Declared as a function (not a const) so it is
// hoisted onto window — audio-mixer.js calls it as window.handleSliderInput,
// matching the window.playSong / window.showScreen cross-script convention.
function handleSliderInput(el) {
    if (!el) return;
    const min = el.min || 0;
    const max = el.max || 100;
    const pct = (el.value - min) / (max - min) * 100;
    el.style.setProperty('--range-pct', pct + '%');
}

// A/V sync calibration. Positive = audio runs ahead of visuals; we
// add this to audio.currentTime when driving the highway so the
// visuals catch up. Persisted via /api/settings as av_offset_ms.
// Live-tunable from the player screen via [ / ] keys (Shift for
// ±50 ms) and from the Settings slider; both auto-save with the
// same debounced POST. loadSettings() seeds the value via
// setAvOffsetMs without saving (skipPersist=true) to avoid an
// echo-back round-trip.
let _avOffsetMs = 0;
let _avSaveDebounce = null;
function setAvOffsetMs(ms, skipPersist) {
    // Clamp to the same bounds the Settings/player-bar sliders enforce
    // (-1000..1000 ms). Defends against bad values from /api/settings
    // landing as `value` on <input type=range>.
    const n = Number(ms);
    _avOffsetMs = Math.max(-1000, Math.min(1000, Number.isFinite(n) ? n : 0));
    // Drive the highway's render-time shift. getTime() still returns
    // the audio-aligned chart time so plugins (note detection, etc.)
    // keep scoring against the real chart clock regardless of visual
    // calibration.
    if (typeof highway !== 'undefined' && highway?.setAvOffset) highway.setAvOffset(_avOffsetMs);
    // Sync any visible Settings slider
    const avSlider = document.getElementById('setting-av-offset');
    if (avSlider) {
        avSlider.value = _avOffsetMs;
        handleSliderInput(avSlider);
    }
    const avVal = document.getElementById('setting-av-offset-val');
    if (avVal) avVal.textContent = Math.round(_avOffsetMs);
    // Sync the inline player-bar slider (live-tunable while playing)
    const playerAvSlider = document.getElementById('player-av-offset-slider');
    if (playerAvSlider) {
        playerAvSlider.value = _avOffsetMs;
        handleSliderInput(playerAvSlider);
    }
    const playerAvLabel = document.getElementById('player-av-offset-label');
    if (playerAvLabel) {
        const rounded = Math.round(_avOffsetMs);
        playerAvLabel.textContent = `${rounded >= 0 ? '+' : ''}${rounded}ms`;
    }
    // Update the player HUD readout (hidden when offset = 0 to
    // avoid clutter; the keyboard shortcut is documented in the
    // Settings help text so it stays discoverable).
    const hud = document.getElementById('hud-avoffset');
    if (hud) {
        hud.textContent = `A/V ${_avOffsetMs >= 0 ? '+' : ''}${Math.round(_avOffsetMs)} ms`;
        hud.classList.toggle('hidden', _avOffsetMs === 0);
    }
    if (!skipPersist) _persistAvOffset();
}
function _persistAvOffset() {
    // Debounced persist — POST only the one field; the server merges.
    if (_avSaveDebounce) clearTimeout(_avSaveDebounce);
    _avSaveDebounce = setTimeout(async () => {
        _avSaveDebounce = null;
        try {
            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ av_offset_ms: _avOffsetMs }),
            });
        } catch (e) {
            console.warn('A/V offset save failed:', e);
        }
    }, 400);
}
function nudgeAvOffsetMs(delta) {
    setAvOffsetMs(Math.max(-1000, Math.min(1000, _avOffsetMs + delta)));
}

// Open a native OS folder picker via the Electron bridge (desktop only) and
// stash the chosen path into the DLC input. User still has to hit Save.
async function pickDlcFolder() {
    if (!window.feedBackDesktop?.pickDirectory) return;
    const path = await window.feedBackDesktop.pickDirectory();
    if (path) document.getElementById('dlc-path').value = path;
}

async function saveSettings() {
    const defaultArrangement = document.getElementById('default-arrangement').value;
    const resp = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            dlc_dir: document.getElementById('dlc-path').value.trim(),
            default_arrangement: defaultArrangement,
            demucs_server_url: document.getElementById('demucs-server-url').value.trim(),
            av_offset_ms: _avOffsetMs,
        }),
    });
    const data = await resp.json();
    if (resp.ok) {
        _defaultArrangement = defaultArrangement;
        _syncDefaultArrangementSelect(_defaultArrangement);
        syncDefaultArrangementPin();
    }
    document.getElementById('settings-status').textContent = data.message || data.error;
}

document.getElementById('arr-select')?.addEventListener('change', syncDefaultArrangementPin);

// Persist a single settings field the instant a control changes (used by
// the Settings dropdowns). The /api/settings POST handler merges only the
// keys present in the body, so this one-field write won't clobber dlc_dir
// or any other setting. No debounce: a <select> change event fires once
// per selection, unlike the A/V / mastery sliders' per-pixel oninput.
//
// The Settings-dropdown autosaves run through one chain so their POSTs are
// sent one at a time, in the order the user made the changes — the last
// selection is always the last write, for both rapid changes to one
// dropdown and back-to-back changes across different dropdowns. The A/V
// and mastery slider autosaves POST directly (not through this chain);
// the server-side config.json lock is what keeps those from racing the
// dropdown writes (see save_settings() in server.py).
let _settingSaveChain = Promise.resolve();
function persistSetting(key, value) {
    const next = _settingSaveChain.then(() => _postSetting(key, value));
    // Swallow failures so one failed write doesn't poison the chain and
    // block every later save.
    _settingSaveChain = next.catch(() => {});
    return next;
}
function setInstrumentPathway(value) {
    const pathway = _normalizeInstrumentPathway(value);
    const el = document.getElementById('setting-instrument-pathway');
    if (el) el.value = pathway;
    persistSetting('pathway', pathway).then(() => {
        if (window.v3Badges && typeof window.v3Badges.reload === 'function') {
            try { window.v3Badges.reload(); } catch (_) { /* noop */ }
        }
    });
}


async function _postSetting(key, value) {
    const status = document.getElementById('settings-status');
    try {
        const resp = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [key]: value }),
        });
        const data = await resp.json();
        if (status) status.textContent = data.message || data.error || '';
    } catch (e) {
        if (status) status.textContent = 'Save failed: ' + e.message;
    }
}

// ── Settings export / import (feedBack#113) ─────────────────────────────────
//
// Bundles server config + every localStorage key + opted-in plugin server
// files into a single JSON file.
//
// Apply semantics — phased, NOT all-or-nothing across the two stores:
//   1. Server first (/api/settings/import). Phase-1 validation guards
//      the whole bundle; phase-2 disk commit is per-file but ordered
//      so a mid-apply failure surfaces a `partial` field. A server
//      failure short-circuits before any localStorage write, so the
//      browser side stays untouched on validation refusals.
//   2. localStorage second, only after the server returns ok. Applied
//      as a MERGE (no clear): bundled keys overwrite, locally-present
//      keys absent from the bundle are preserved (so a plugin
//      installed after the export keeps its first-run defaults).
//      A localStorage exception here (quota / private mode) is
//      surfaced verbatim — server state is already committed and we
//      don't pretend the import was clean.
//
// In short: the server side is atomic in phase 1 and surface-partial in
// phase 2; the localStorage side is best-effort merge after server
// success. Failures are reported, never silenced.

async function exportSettings() {
    const status = document.getElementById('backup-status');
    status.textContent = 'Exporting...';
    try {
        const resp = await fetch('/api/settings/export');
        if (!resp.ok) {
            status.textContent = `Export failed (HTTP ${resp.status})`;
            return;
        }
        const bundle = await resp.json();
        // Layer in the browser's localStorage. Use the standard Storage
        // iteration API (length + key(i)) rather than Object.keys —
        // Object.keys on a Storage instance is not deterministic across
        // browsers and can both miss entries and include non-entry
        // properties depending on the implementation. Keys are preserved
        // verbatim as strings; that's how localStorage stores them, and
        // round-trip fidelity matters more than re-typing values that
        // were never typed in the first place.
        const localStorageData = {};
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key === null) continue;
            const value = localStorage.getItem(key);
            if (value !== null) localStorageData[key] = value;
        }
        bundle.local_storage = localStorageData;

        // Trigger download via blob + temporary <a download>. We honor the
        // server's Content-Disposition filename when present, otherwise
        // fall back to a date-stamped default.
        let filename = 'feedBack-settings.json';
        const disposition = resp.headers.get('Content-Disposition');
        if (disposition) {
            const match = /filename="([^"]+)"/.exec(disposition);
            if (match) filename = match[1];
        }
        const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        status.textContent = `Exported ${filename}`;
    } catch (e) {
        status.textContent = `Export failed: ${e.message}`;
    }
}

async function importSettings(file) {
    if (!file) return;
    const status = document.getElementById('backup-status');
    if (!confirm('Import will overwrite settings present in the bundle (server config, browser preferences, and opted-in plugin data) and reload the page. Settings not in the bundle (e.g. from plugins installed after the export) are preserved. Continue?')) {
        status.textContent = 'Import cancelled';
        return;
    }
    let bundle;
    try {
        bundle = JSON.parse(await file.text());
    } catch (e) {
        status.textContent = `Import failed: not valid JSON (${e.message})`;
        return;
    }

    status.textContent = 'Importing...';
    let resp, data;
    try {
        resp = await fetch('/api/settings/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bundle),
        });
        data = await resp.json();
    } catch (e) {
        status.textContent = `Import failed: ${e.message}`;
        return;
    }
    // Two failure shapes to surface: our own validation handler
    // returns `{ok: false, error: "..."}`, but if the body fails
    // FastAPI's request-level validation (e.g. top-level value is
    // an array, not an object), the response is the framework's
    // `{detail: ...}` shape with no `ok` key. `resp.ok` distinguishes
    // both from success without depending on which path produced
    // the failure.
    if (!resp.ok || data.ok === false) {
        let msg = data.error;
        if (!msg && data.detail) {
            msg = typeof data.detail === 'string'
                ? data.detail
                : JSON.stringify(data.detail);
        }
        status.textContent = `Import failed: ${msg || `HTTP ${resp.status}`}`;
        return;
    }

    // Server applied successfully. Now apply the localStorage portion as
    // a MERGE (not clear+restore): keys in the bundle overwrite, keys
    // present locally but absent from the bundle are preserved. This
    // matters when a plugin was installed *after* the export — wiping
    // its localStorage would erase first-run defaults the plugin set on
    // load, leaving it in a worse state than before the import. The
    // tradeoff is that orphan keys from removed plugins or renamed key
    // schemes also linger; cleaning those up is the user's job.
    const ls = bundle.local_storage;
    if (ls && typeof ls === 'object') {
        try {
            for (const [key, value] of Object.entries(ls)) {
                if (typeof value === 'string') localStorage.setItem(key, value);
            }
        } catch (e) {
            // Quota exceeded / private mode etc. Server side already
            // committed, so we surface the partial state rather than
            // pretending it succeeded.
            status.textContent = `Server applied, but localStorage write failed: ${e.message}`;
            return;
        }
    }

    const warnings = (data.warnings || []).join('; ');
    status.textContent = warnings ? `Imported with warnings: ${warnings}. Reloading...` : 'Imported. Reloading...';
    setTimeout(() => location.reload(), 800);
}

// ── Diagnostics export (feedBack#166) ───────────────────────────────────
//
// Companion to Settings export but for troubleshooting bug reports.
// Bundle layout + schemas: docs/diagnostics-bundle-spec.md.
//
// Frontend's job is to:
//   1. Snapshot the browser-only state (console ring buffer, hardware
//      probe, localStorage, ua) via window.feedBack.diagnostics.
//   2. POST it to /api/diagnostics/export with the user's include /
//      redact toggles.
//   3. Stream the returned zip to disk.

function _diagIncludeFromUI() {
    const v = (id) => document.getElementById(id)?.checked !== false;
    return {
        system: v('diag-incl-system'),
        hardware: v('diag-incl-hardware'),
        logs: v('diag-incl-logs'),
        console: v('diag-incl-console'),
        plugins: v('diag-incl-plugins'),
    };
}

function _diagRedactFromUI() {
    const el = document.getElementById('diag-redact');
    return el ? !!el.checked : true;
}

// Map raw file paths inside the bundle to plain-English labels +
// descriptions for the preview UI. Only paths that show up in
// previews need entries — unknown paths fall back to the path itself.
const _DIAG_FILE_LABELS = {
    'system/version.json':   { label: 'App version',    desc: 'FeedBack version, Python, OS' },
    'system/env.json':       { label: 'Environment',    desc: 'Allowlisted env vars (LOG_LEVEL, etc.). No secrets.' },
    'system/hardware.json':  { label: 'Hardware (server-side)', desc: 'CPU, RAM, GPU. In Docker this reflects the container, not the host.' },
    'system/plugins.json':   { label: 'Plugins',        desc: 'Loaded plugins + git commit + orphan detection.' },
    'logs/server.log':       { label: 'Server log',     desc: 'Tail of LOG_FILE (last ~5 MB).' },
    'logs/server.log.meta.json': { label: 'Log metadata', desc: 'Log file path, size, rotation info.' },
    'client/console.json':   { label: 'Browser console', desc: 'console.log/warn/error transcript + window errors.' },
    'client/hardware.json':  { label: 'Hardware (browser)', desc: 'WebGL/WebGPU adapter, host OS via userAgent.' },
    'client/local_storage.json': { label: 'Browser storage', desc: 'localStorage contents (preferences).' },
    'client/ua.json':        { label: 'User agent',     desc: 'Browser, screen, page URL.' },
};

function _formatBytes(n) {
    if (!n || n < 1024) return (n || 0) + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function _escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function _renderDiagPreview(data) {
    const m = data.manifest || {};
    const files = m.files || [];
    const groups = { system: [], logs: [], client: [], plugins: [], other: [] };
    for (const f of files) {
        const top = (f.path || '').split('/')[0];
        (groups[top] || groups.other).push(f);
    }
    const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0);
    const include = _diagIncludeFromUI();
    const redact = _diagRedactFromUI();

    const sections = [];
    // Per-file `summary` (server-derived) → human one-liner.
    function _summaryLine(path, summary) {
        if (!summary || typeof summary !== 'object') return '';
        if (path === 'system/plugins.json') {
            const loaded = summary.loaded_count || 0;
            const orphans = summary.orphan_count || 0;
            const orphPart = orphans ? ` · <span class="text-amber-400">${orphans} orphan${orphans === 1 ? '' : 's'}</span>` : '';
            return `${loaded} plugin${loaded === 1 ? '' : 's'} loaded${orphPart}`;
        }
        if (path === 'client/console.json') {
            const total = summary.entry_count || 0;
            const lvl = summary.by_level || {};
            const parts = [];
            for (const k of ['error','warn','info','log','debug']) {
                if (lvl[k]) parts.push(`${lvl[k]} ${k}`);
            }
            return `${total} entries${parts.length ? ' (' + parts.join(', ') + ')' : ''}`;
        }
        if (path === 'system/hardware.json') {
            const bits = [];
            if (summary.cpu_brand) bits.push(summary.cpu_brand);
            if (summary.cores_logical) bits.push(`${summary.cores_logical} cores`);
            if (summary.gpu_count) bits.push(`${summary.gpu_count} GPU`);
            if (summary.runtime) bits.push(`runtime: ${summary.runtime}`);
            return bits.join(' · ');
        }
        if (path === 'client/hardware.json') {
            const bits = [];
            if (summary.runtime) bits.push(summary.runtime);
            if (summary.webgl_renderer) bits.push(summary.webgl_renderer);
            return bits.join(' · ');
        }
        if (path === 'client/local_storage.json') {
            return `${summary.key_count || 0} keys`;
        }
        if (path === 'system/version.json') {
            const bits = [];
            if (summary.feedBack) bits.push(`feedBack ${summary.feedBack}`);
            if (summary.python) bits.push(`python ${summary.python}`);
            if (summary.os) bits.push(summary.os);
            return bits.join(' · ');
        }
        return '';
    }

    function pushSection(title, list, emptyHint) {
        if (!list.length) {
            if (emptyHint) {
                sections.push(`<div class="mb-3"><div class="text-gray-300 font-semibold mb-1">${_escapeHtml(title)}</div><div class="text-gray-500">${_escapeHtml(emptyHint)}</div></div>`);
            }
            return;
        }
        const rows = list.map(f => {
            const meta = _DIAG_FILE_LABELS[f.path] || { label: f.path, desc: '' };
            const summary = _summaryLine(f.path, f.summary);
            const summaryHtml = summary
                ? `<div class="text-accent-light text-[10px] mt-0.5">${summary}</div>`
                : '';
            return `<div class="flex justify-between gap-4 py-1 border-b border-dark-600 last:border-0">
                <div class="min-w-0">
                    <div class="text-gray-200">${_escapeHtml(meta.label)}</div>
                    <div class="text-gray-500 text-[10px]">${_escapeHtml(meta.desc)}</div>
                    ${summaryHtml}
                </div>
                <div class="text-gray-400 text-right whitespace-nowrap">${_escapeHtml(_formatBytes(f.size))}</div>
            </div>`;
        }).join('');
        sections.push(`<div class="mb-3"><div class="text-gray-300 font-semibold mb-1">${_escapeHtml(title)}</div>${rows}</div>`);
    }

    pushSection('System', groups.system, include.system ? '' : 'Skipped (toggle off)');
    pushSection('Server logs', groups.logs, include.logs
        ? 'No log file configured — set LOG_FILE env var to include server logs.'
        : 'Skipped (toggle off)');
    pushSection('Plugin diagnostics', groups.plugins, include.plugins
        ? 'No plugins have opted in to diagnostics.'
        : 'Skipped (toggle off)');

    // Client section preview is a server-side estimate only — actual
    // client/* payloads are added at Export time after the browser
    // snapshots. Show what WILL be added, not file sizes.
    const clientLines = [];
    if (include.console) clientLines.push({ label: 'Browser console', desc: 'console.log/warn/error transcript + window errors.' });
    if (include.hardware) clientLines.push({ label: 'Hardware (browser)', desc: 'WebGL/WebGPU adapter, host OS via userAgent.' });
    clientLines.push({ label: 'Browser storage', desc: 'localStorage contents (preferences).' });
    clientLines.push({ label: 'User agent', desc: 'Browser, screen, page URL.' });
    const clientHtml = clientLines.map(c => `<div class="flex justify-between gap-4 py-1 border-b border-dark-600 last:border-0">
        <div><div class="text-gray-200">${_escapeHtml(c.label)}</div><div class="text-gray-500 text-[10px]">${_escapeHtml(c.desc)}</div></div>
        <div class="text-gray-500 text-right whitespace-nowrap">added on export</div>
    </div>`).join('');
    sections.push(`<div class="mb-3"><div class="text-gray-300 font-semibold mb-1">Browser data</div>${clientHtml}</div>`);

    const notesHtml = (m.notes || []).length
        ? `<div class="mb-3 bg-dark-600 border border-amber-500/30 rounded-lg p-2">
              <div class="text-amber-400 text-[10px] font-semibold uppercase mb-1">Notes</div>
              ${(m.notes).map(n => `<div class="text-gray-300 text-[11px]">• ${_escapeHtml(n)}</div>`).join('')}
           </div>`
        : '';

    const privacyHtml = redact
        ? `<div class="text-emerald-400 text-[11px]">🔒 Redaction enabled — paths, song names, IPs, and secrets will be replaced with stable hash tokens.</div>`
        : `<div class="text-amber-400 text-[11px]">⚠ Redaction OFF — bundle will contain raw paths, song names, and IPs. Only share with people you trust.</div>`;

    return `
        <div class="text-[11px]">
            <div class="flex justify-between items-baseline mb-2">
                <div class="text-gray-200 font-semibold">${_escapeHtml(data.filename)}</div>
                <div class="text-gray-400">${_escapeHtml(_formatBytes(totalBytes))}<span class="text-gray-600"> server-side</span></div>
            </div>
            <div class="text-gray-500 text-[10px] mb-3">runtime: ${_escapeHtml(m.runtime || 'unknown')} · exported_at: ${_escapeHtml(m.exported_at || '')}</div>
            ${notesHtml}
            ${sections.join('')}
            ${privacyHtml}
        </div>`;
}

async function previewDiagnostics() {
    const status = document.getElementById('diag-status');
    const preview = document.getElementById('diag-preview');
    if (!status || !preview) return;
    status.textContent = 'Building preview…';
    preview.classList.add('hidden');
    const include = _diagIncludeFromUI();
    const params = new URLSearchParams({
        redact: String(_diagRedactFromUI()),
        system: String(include.system),
        hardware: String(include.hardware),
        logs: String(include.logs),
        console: String(include.console),
        plugins: String(include.plugins),
    });
    try {
        const resp = await fetch(`/api/diagnostics/preview?${params.toString()}`);
        if (!resp.ok) {
            status.textContent = `Preview failed (HTTP ${resp.status})`;
            return;
        }
        const data = await resp.json();
        preview.innerHTML = _renderDiagPreview(data);
        preview.classList.remove('hidden');
        status.textContent = 'Preview ready.';
    } catch (e) {
        status.textContent = `Preview failed: ${e.message}`;
    }
}

async function exportDiagnostics() {
    const status = document.getElementById('diag-status');
    if (!status) return;
    status.textContent = 'Building bundle…';
    const include = _diagIncludeFromUI();
    const redact = _diagRedactFromUI();

    const diag = window.feedBack && window.feedBack.diagnostics;
    const body = {
        redact,
        include,
        client_console: include.console && diag ? diag.snapshotConsole() : null,
        client_hardware: include.hardware && diag ? await diag.snapshotHardware() : null,
        client_ua: diag ? diag.snapshotUa() : null,
        local_storage: diag ? diag.snapshotLocalStorage() : null,
        client_contributions: diag ? diag.snapshotContributions() : null,
    };

    let resp;
    try {
        resp = await fetch('/api/diagnostics/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    } catch (e) {
        status.textContent = `Export failed: ${e.message}`;
        return;
    }
    if (!resp.ok) {
        status.textContent = `Export failed (HTTP ${resp.status})`;
        return;
    }
    let filename = 'feedBack-diag.zip';
    const disp = resp.headers.get('Content-Disposition');
    if (disp) {
        const m = /filename="([^"]+)"/.exec(disp);
        if (m) filename = m[1];
    }
    try {
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        status.textContent = `Exported ${filename}`;
    } catch (e) {
        status.textContent = `Export failed during download: ${e.message}`;
    }
}

async function uploadSongs(fileList) {
    if (!fileList || fileList.length === 0) return;
    const all = Array.from(fileList);
    // Optional UI element — only present when on the Settings screen.
    // The navbar entry triggers uploads from any screen, where these aren't.
    const status = document.getElementById('rescan-status');
    const setStatus = (s) => { if (status) status.textContent = s; };

    // Client-side extension filter so we don't waste a round-trip on
    // clearly-invalid picks. The server validates again.
    const failures = [];
    const files = [];
    for (const f of all) {
        const lower = f.name.toLowerCase();
        if (lower.endsWith('.feedpak') || lower.endsWith('.sloppak')) {
            files.push(f);
        } else {
            failures.push(`${f.name}: only .feedpak or .sloppak accepted`);
        }
    }
    if (files.length === 0) {
        if (failures.length) alert(failures.join('\n'));
        return;
    }

    // The backend caps batches at _MAX_UPLOAD_FILES (50). Chunk if needed so a
    // big drag-and-drop of an album folder still works end-to-end.
    const BATCH = 50;
    const chunks = [];
    for (let i = 0; i < files.length; i += BATCH) chunks.push(files.slice(i, i + BATCH));

    let uploaded = 0;

    const postChunk = async (chunk, overwrite) => {
        const form = new FormData();
        for (const f of chunk) form.append('file', f);
        const url = '/api/songs/upload' + (overwrite ? '?overwrite=1' : '');
        const resp = await fetch(url, { method: 'POST', body: form });
        if (!resp.ok) {
            let data = {};
            try { data = await resp.json(); } catch (_) {}
            // Whole-request rejection (DLC misconfig, payload too large, etc.).
            throw new Error(data.error || resp.statusText || `HTTP ${resp.status}`);
        }
        const body = await resp.json();
        return body.results || [];
    };

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const label = chunks.length > 1
            ? `Uploading batch ${i + 1}/${chunks.length} (${chunk.length} files)...`
            : `Uploading ${chunk.length} file${chunk.length === 1 ? '' : 's'}...`;
        setStatus(label);

        let results;
        try {
            results = await postChunk(chunk, false);
        } catch (e) {
            for (const f of chunk) failures.push(`${f.name}: ${e.message}`);
            continue;
        }

        // Index file objects by name so a follow-up overwrite request can
        // resend the same blobs. Names within a chunk are unique on disk
        // (DLC dir is flat for this purpose), but two distinct user picks
        // could share a name — Map.set keeps the last one, which matches
        // server-side last-write-wins semantics.
        const byName = new Map(chunk.map(f => [f.name, f]));

        const conflicts = [];
        for (const r of results) {
            if (r.status === 'ok') {
                uploaded++;
            } else if (r.status === 'exists') {
                conflicts.push(r);
            } else {
                failures.push(`${r.filename}: ${r.error || 'upload failed'}`);
            }
        }

        if (conflicts.length > 0) {
            const names = conflicts.map(c => c.filename);
            const preview = names.slice(0, 5).join(', ') + (names.length > 5 ? `, +${names.length - 5} more` : '');
            const ok = confirm(
                `${conflicts.length} file${conflicts.length === 1 ? '' : 's'} already exist in your DLC folder:\n${preview}\n\nOverwrite?`
            );
            if (!ok) {
                for (const c of conflicts) failures.push(`${c.filename}: skipped (already exists)`);
                continue;
            }
            const retryFiles = conflicts
                .map(c => byName.get(c.filename))
                .filter(Boolean);
            setStatus(`Overwriting ${retryFiles.length} file${retryFiles.length === 1 ? '' : 's'}...`);
            let retryResults;
            try {
                retryResults = await postChunk(retryFiles, true);
            } catch (e) {
                for (const f of retryFiles) failures.push(`${f.name}: ${e.message}`);
                continue;
            }
            for (const r of retryResults) {
                if (r.status === 'ok') uploaded++;
                else failures.push(`${r.filename}: ${r.error || 'upload failed'}`);
            }
        }
    }

    if (failures.length === 0) {
        setStatus(`Uploaded ${uploaded} file${uploaded === 1 ? '' : 's'}. Scanning...`);
    } else {
        // Denominator is the full user selection (`all.length`), not just the
        // post-filter `files.length`. Otherwise picking one valid file plus
        // one `.txt` would show "Uploaded 1/1" with a failure listed below,
        // overstating the success rate.
        const total = all.length;
        const msg = `Uploaded ${uploaded}/${total}. ${failures.length} failed:\n` + failures.join('\n');
        alert(msg);
        setStatus(`Uploaded ${uploaded}/${total}, ${failures.length} failed.`);
    }
    if (uploaded > 0) {
        // Server kicked off a background scan after the batch finished; poll
        // for completion and refresh the library when it finishes.
        _pollScanAndRefresh(status);
    }
}

let _uploadScanPoller = null;

function _pollScanAndRefresh(statusEl) {
    const setStatus = (s) => { if (statusEl) statusEl.textContent = s; };
    if (_uploadScanPoller) _uploadScanPoller.stop();

    const MAX_FAILURES = 5;
    const INTERVAL_MS = 1000;
    let stopped = false;
    let timerId = null;
    let failures = 0;
    const stop = () => {
        stopped = true;
        if (timerId) { clearTimeout(timerId); timerId = null; }
        if (_uploadScanPoller && _uploadScanPoller.stop === stop) _uploadScanPoller = null;
    };
    _uploadScanPoller = { stop };

    const tick = async () => {
        timerId = null;
        try {
            const sr = await fetch('/api/scan-status');
            if (!sr.ok) throw new Error(`HTTP ${sr.status}`);
            const sd = await sr.json();
            if (stopped) return;
            failures = 0;
            if (sd.running) {
                const cur = sd.current ? ` · ${sd.current}` : '';
                setStatus(`${sd.done} / ${sd.total} scanned${cur}...`);
            } else {
                stop();
                if (sd.error) setStatus(`Error: ${sd.error}`);
                else setStatus('Done!');
                _treeStats = null;
                _tuningNames = null;
                // Mirror the delete path: refresh whichever collection is
                // currently visible. Overwriting a favorited song while
                // viewing Favorites otherwise leaves a stale entry.
                const activeScreen = document.querySelector('.screen.active');
                if (activeScreen?.id === 'favorites') loadFavorites();
                else loadLibrary();
                return;
            }
        } catch (e) {
            if (stopped) return;
            failures++;
            if (failures >= MAX_FAILURES) {
                stop();
                setStatus(`Scan status unavailable: ${e.message || e}`);
                return;
            }
        }
        if (!stopped) timerId = setTimeout(tick, INTERVAL_MS);
    };
    timerId = setTimeout(tick, INTERVAL_MS);
}

async function rescanLibrary() {
    const btn = document.getElementById('btn-rescan');
    const status = document.getElementById('rescan-status');
    btn.disabled = true;
    btn.textContent = 'Scanning...';
    status.textContent = '';
    const resp = await fetch('/api/rescan', { method: 'POST' });
    const data = await resp.json();
    status.textContent = data.message;
    // Poll until done
    const poll = setInterval(async () => {
        const sr = await fetch('/api/scan-status');
        const sd = await sr.json();
        if (sd.running) {
            const cur = sd.current ? ` · ${sd.current}` : '';
            status.textContent = `${sd.done} / ${sd.total} scanned${cur}...`;
        } else {
            clearInterval(poll);
            btn.disabled = false;
            btn.textContent = 'Rescan Library';
            status.textContent = sd.error ? `Error: ${sd.error}` : 'Done!';
            _treeStats = null;
            _tuningNames = null;  // re-fetch on next drawer open
            loadLibrary();
            // Tell the v3 Songs grid the library changed so it reloads instead of
            // keeping a cached (e.g. pre-DLC, empty) grid until an app restart.
            if (window.feedBack) window.feedBack.emit('library:changed', { reason: 'rescan' });
        }
    }, 1000);
}

async function fullRescanLibrary() {
    if (!confirm('This will clear the entire library cache and re-scan all songs. This can take a long time with large libraries. Continue?')) return;
    const btn = document.getElementById('btn-full-rescan');
    const status = document.getElementById('rescan-status');
    btn.disabled = true;
    btn.textContent = 'Clearing...';
    const resp = await fetch('/api/rescan/full', { method: 'POST' });
    const data = await resp.json();
    btn.textContent = 'Scanning...';
    status.textContent = data.message;
    const poll = setInterval(async () => {
        const sr = await fetch('/api/scan-status');
        const sd = await sr.json();
        if (sd.running) {
            const cur = sd.current ? ` · ${sd.current}` : '';
            status.textContent = `${sd.done} / ${sd.total} scanned${cur}...`;
        } else {
            clearInterval(poll);
            btn.disabled = false;
            btn.textContent = 'Full Rescan';
            status.textContent = sd.error ? `Error: ${sd.error}` : 'Done!';
            _treeStats = null;
            _tuningNames = null;  // re-fetch on next drawer open
            loadLibrary();
            // Tell the v3 Songs grid the library changed so it reloads instead of
            // keeping a cached (e.g. pre-DLC, empty) grid until an app restart.
            if (window.feedBack) window.feedBack.emit('library:changed', { reason: 'rescan' });
        }
    }, 1000);
}

// ── Plugin Updates ───────────────────────────────────────────────────────
async function checkPluginUpdates() {
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

async function updatePlugin(pluginId, btn) {
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

// ── Plugin functions loaded dynamically from plugin screen.js files ──────
// (searchCF, installCF, loginCF, searchUG, buildFromUG, etc.)

// ── Retune ───────────────────────────────────────────────────────────────
function retuneSong(filename, title, tuning, target) {
    target = target || 'E Standard';
    if (!confirm(`Convert "${title}" from ${tuning} to ${target}?`)) return;

    // Show modal overlay
    const modal = document.createElement('div');
    modal.id = 'retune-modal';
    modal.className = 'fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm';
    modal.innerHTML = `
        <div class="bg-dark-700 border border-gray-700 rounded-2xl p-8 w-full max-w-md mx-4 shadow-2xl">
            <h3 class="text-lg font-bold text-white mb-1">Converting to ${target}</h3>
            <p class="text-sm text-gray-400 mb-5">${title}</p>
            <div class="progress-bar mb-3"><div class="fill" id="retune-bar" style="width:0%"></div></div>
            <p class="text-xs text-gray-500" id="retune-stage">Connecting...</p>
        </div>`;
    document.body.appendChild(modal);

    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/retune?filename=${encodeURIComponent(decodeURIComponent(filename))}&target=${encodeURIComponent(target)}`);
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.progress !== undefined) {
            document.getElementById('retune-bar').style.width = msg.progress + '%';
        }
        if (msg.stage) {
            document.getElementById('retune-stage').textContent = msg.stage;
        }
        if (msg.done) {
            modal.querySelector('.bg-dark-700').innerHTML = `
                <div class="text-center">
                    <div class="text-3xl mb-3">✓</div>
                    <h3 class="text-lg font-bold text-white mb-1">Done!</h3>
                    <p class="text-sm text-gray-400 mb-5">${msg.filename}</p>
                    <button onclick="document.getElementById('retune-modal').remove();loadLibrary()"
                        class="bg-accent hover:bg-accent-light px-6 py-2 rounded-xl text-sm font-semibold text-white transition">OK</button>
                </div>`;
        }
        if (msg.error) {
            modal.querySelector('.bg-dark-700').innerHTML = `
                <div class="text-center">
                    <div class="text-3xl mb-3">✕</div>
                    <h3 class="text-lg font-bold text-red-400 mb-1">Failed</h3>
                    <p class="text-sm text-gray-400 mb-5">${msg.error}</p>
                    <button onclick="document.getElementById('retune-modal').remove()"
                        class="bg-dark-600 hover:bg-dark-500 px-6 py-2 rounded-xl text-sm text-gray-300 transition">Close</button>
                </div>`;
        }
    };
    ws.onerror = () => {
        modal.querySelector('.bg-dark-700').innerHTML = `
            <div class="text-center">
                <p class="text-red-400 mb-4">Connection lost</p>
                <button onclick="document.getElementById('retune-modal').remove()"
                    class="bg-dark-600 px-6 py-2 rounded-xl text-sm text-gray-300">Close</button>
            </div>`;
    };
}

// ── Player ───────────────────────────────────────────────────────────────
const audio = document.getElementById('audio');
let isPlaying = false;
let _lastSongPositionEventAt = 0;

function _emitSongPositionChanged(time, duration) {
    const now = Date.now();
    if (now - _lastSongPositionEventAt < 250) return;
    _lastSongPositionEventAt = now;
    const payload = (typeof _songEventPayload === 'function') ? _songEventPayload() : { time };
    window.feedBack.emit('song:position-changed', Object.assign(payload, { duration }));
}

function _applyPreservePitch(el) {
    if (!el) return;
    if ('preservesPitch' in el) el.preservesPitch = true;
    if ('mozPreservesPitch' in el) el.mozPreservesPitch = true;
    if ('webkitPreservesPitch' in el) el.webkitPreservesPitch = true;
}
_applyPreservePitch(audio);

// In FeedBack Desktop, WASAPI Exclusive Mode locks the audio device so Chromium
// cannot play through it. When window._juceMode is true, song audio is routed
// through the JUCE backing track player instead of the HTML5 <audio> element.
window._juceMode = false;
window._juceAudioUrl = null;
const jucePlayer = {
    _timer: null,
    _pos: 0,
    _dur: 0,
    _pollAt: 0,    // performance.now() when _pos was last set
    _polling: false,
    _speed: 1,
    get currentTime() {
        if (!this._polling) return this._pos;
        // Interpolate between IPC polls so highway motion is smooth at 60fps
        // Scale by _speed so at 0.7x the interpolated clock advances 0.7s/s
        const elapsed = (performance.now() - this._pollAt) / 1000;
        return Math.min(this._pos + elapsed * this._speed, this._dur > 0 ? this._dur : Infinity);
    },
    get duration() { return this._dur; },
    async play() {
        try {
            await window.feedBackDesktop.audio.startBacking();
        } catch (err) {
            console.warn('[jucePlayer] startBacking failed:', err);
            return false;
        }
        this._startPolling();
        return true;
    },
    async pause() {
        // Snapshot the interpolated position before stopping the poll so
        // _pos stays at the visible pause point rather than jumping back
        // to the last raw IPC sample (which can be up to 100ms behind).
        this._pos = this.currentTime;
        this._pollAt = performance.now();
        this._stopPolling();
        try {
            await window.feedBackDesktop.audio.stopBacking();
        } catch (err) {
            console.warn('[jucePlayer] stopBacking failed:', err);
        }
    },
    async seek(s) {
        const prev = this._pos;
        this._pos = s;
        this._pollAt = performance.now();
        try {
            await window.feedBackDesktop.audio.seekBacking(s);
        } catch (err) {
            console.warn('[jucePlayer] seekBacking failed:', err);
            this._pos = prev;
            this._pollAt = performance.now();
        }
    },
    _startPolling() {
        this._stopPolling();
        this._polling = true;
        this._pollAt = performance.now();
        const self = this;
        function scheduleNext() {
            self._timer = setTimeout(async () => {
                if (!self._polling) return;
                try {
                    self._pos = await window.feedBackDesktop.audio.getBackingPosition();
                    self._pollAt = performance.now();
                    _emitSongPositionChanged(self.currentTime, self.duration || null);
                } catch (err) {
                    console.warn('[jucePlayer] position poll failed:', err);
                } finally {
                    if (self._polling) scheduleNext();
                }
            }, 100);
        }
        scheduleNext();
    },
    _stopPolling() {
        this._polling = false;
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    },
    setRate(rate) {
        this._pos = this.currentTime;
        this._pollAt = performance.now();
        this._speed = rate;
    },
    async stop() {
        await this.pause();
        this._pos = 0;
        this._dur = 0;
        this._pollAt = 0;
        this._speed = 1;
    },
};
window.jucePlayer = jucePlayer;

// ── Engine start/stop → re-route song audio (HTML5 ⇄ JUCE) ──────────────────
// window._juceMode is otherwise decided once, at song-load time (highway.js),
// from isAudioRunning(). If the JUCE audio engine is started or stopped *after*
// a song is already loaded (e.g. the user presses CHAIN / AMP), that decision
// goes stale: the song stays on the HTML5 <audio> element while the engine
// grabs the device in exclusive mode (audible guitar, silent song), or it stays
// on a dead JUCE backing transport. This watcher migrates the loaded song
// between the two paths whenever the engine's running state changes, preserving
// playback position and play/pause state.
(function _installJuceEngineRoutingWatcher() {
    const juceApi = window.feedBackDesktop?.audio;
    if (!juceApi || typeof juceApi.isAudioRunning !== 'function') return;

    let _rerouteInFlight = false;
    // URL that JUCE's loadBackingTrack *explicitly rejected* (ok === false —
    // e.g. a codec it can't read). The poll below would otherwise retry the
    // same doomed track every 350 ms; remember it and skip until the song
    // changes. Only a hard JUCE reject is memoised here — transient failures
    // (a network blip on /api/audio-local-path, an isAudioRunning() race
    // during a device restart) are deliberately NOT memoised so they retry.
    let _rerouteRejectedUrl = null;
    // Exclusive-style output backends silence every other client on the
    // endpoint — including our own <audio> element. The share mode IS the
    // JUCE output device type: "Windows Audio (Exclusive Mode)" is a
    // hardcoded, unlocalised JUCE type name; ASIO drivers typically hold
    // the endpoint exclusively too. "Windows Audio (Low Latency Mode)" is
    // shared and must NOT match.
    function _isExclusiveOutputType(t) {
        return t === 'Windows Audio (Exclusive Mode)' || t === 'ASIO';
    }
    // [feedpak-route] diagnostics: log the raw outputType string once per
    // value change (this runs on a 350ms poll — logging every tick would
    // flood the diagnostics buffer).
    let _loggedOutputType;
    // [asio-diag] verbose diagnostics, gated on --debug (preload exposes
    // audio.debugEnabled). Resolved once at install; until it resolves the
    // flag stays false and verbose lines are skipped. Shared with the
    // renderer-bus feeder below via window._asioDiagEnabled.
    let _asioDiag = false;
    if (typeof juceApi.debugEnabled === 'function') {
        juceApi.debugEnabled().then((v) => { _asioDiag = !!v; }).catch(() => {});
    }
    window._asioDiagEnabled = () => _asioDiag;
    async function _outputIsExclusive() {
        if (typeof juceApi.getCurrentDevice !== 'function') {
            if (_loggedOutputType !== '<no-getCurrentDevice>') {
                _loggedOutputType = '<no-getCurrentDevice>';
                console.warn('[feedpak-route] juceApi.getCurrentDevice missing — cannot detect exclusive output');
            }
            return false;
        }
        try {
            const dev = await juceApi.getCurrentDevice();
            const t = dev?.outputType || dev?.type || '';
            const excl = _isExclusiveOutputType(t);
            if (t !== _loggedOutputType) {
                _loggedOutputType = t;
                console.log('[feedpak-route] outputType=', JSON.stringify(t), '→ exclusive=', excl);
                // [asio-diag] full device object on every type change — shows
                // the exact strings the predicate saw (inputType vs outputType,
                // device names, duplex), so a driver reporting a non-'ASIO'
                // type name is visible in tester logs.
                if (_asioDiag) {
                    try {
                        console.log('[asio-diag] getCurrentDevice=', JSON.stringify(dev));
                    } catch (_) { /* circular/hostile object — skip */ }
                }
            }
            return excl;
        } catch (e) {
            if (_loggedOutputType !== '<getCurrentDevice-failed>') {
                _loggedOutputType = '<getCurrentDevice-failed>';
                console.warn('[feedpak-route] getCurrentDevice failed:', e);
            }
            return false;
        }
    }
    // highway.js's initial song-load routing consults this for the same
    // feedpak-under-exclusive decision the watcher makes below.
    window._juceOutputIsExclusive = _outputIsExclusive;
    // Returns true when window._currentSongAudio no longer references the exact
    // snapshot object captured at reroute entry — i.e. the song was swapped (or
    // cleared) mid-flight. Staleness is detected by object-reference identity,
    // not by URL value.
    function _isStale(songAudio) {
        return window._currentSongAudio !== songAudio;
    }

    // Migrates the loaded song from the HTML5 element onto the JUCE backing
    // transport. Throws only on transient/unexpected failures.
    // `songAudio` is the snapshot captured at reroute entry; if it stops being
    // the current song mid-flight we abort without mutating global routing.
    // Returns a distinct string outcome — the caller must NOT conflate them:
    //   'switched' — song now plays via JUCE.
    //   'rejected' — JUCE hard-rejected the track (codec). Caller memoises it.
    //   'stale'    — the loaded song changed mid-flight; aborted, NOT memoised.
    // (a transient transport-start failure throws instead — also not memoised.)
    async function _switchHtml5ToJuce(songAudio) {
        const url = songAudio.url;
        const wasPlaying = isPlaying;
        const pos = audio.currentTime || 0;
        window.feedBack?.playback?.recordRouteChange?.({
            routeKind: 'desktop-native',
            state: 'switching',
            preservedTime: true,
            safeReason: 'desktop audio engine became active',
            requesterId: 'core.juce-route',
        });
        // Mark a reroute in progress so the <audio> 'play'/'pause' listeners
        // suppress their song:play / song:pause emissions: the migration is
        // transparent — playback genuinely continues — so plugin state and
        // window.feedBack.isPlaying must NOT flip. This also silences the
        // "Audio paused unexpectedly" diagnostic. A REFCOUNT (not a boolean)
        // lets an overlapping reroute's deferred release coexist: each switch
        // increments on entry and decrements after its own timeout; listeners
        // treat any count > 0 as "reroute active".
        window._juceRerouteInProgress = (window._juceRerouteInProgress || 0) + 1;
        audio.pause();
        try {
            const res = await fetch(`/api/audio-local-path?url=${encodeURIComponent(url)}`);
            if (!res.ok) {
                console.warn('[feedpak-route] audio-local-path HTTP', res.status, 'for', url);
                throw new Error('HTTP ' + res.status);
            }
            const { path } = await res.json();
            console.log('[feedpak-route] audio-local-path resolved:', (typeof path === 'string' && path.split(/[\\/]/).pop()) || '<missing>');
            if (_isStale(songAudio)) return 'stale';   // song changed mid-fetch
            const ok = await juceApi.loadBackingTrack(path);
            if (ok === false) {
                // JUCE rejected the track — stay on HTML5, resume if needed.
                console.warn('[juce-reroute] loadBackingTrack rejected; staying on HTML5');
                // Only resume if the element still has a source. In the normal
                // flow audio.src is intact here, but a prior HTML5→JUCE switch
                // clears it — re-point + load before resuming so a bounced
                // reroute doesn't try to play() an empty element.
                if (isPlaying && !_isStale(songAudio)) {
                    if (!audio.src) { audio.src = url; audio.load(); }
                    try { await audio.play(); } catch (_) { /* ignore */ }
                }
                window.feedBack?.playback?.recordRouteChange?.({
                    routeKind: 'browser-media',
                    state: 'degraded',
                    preservedTime: true,
                    safeReason: 'desktop audio route rejected track; kept browser media route',
                    requesterId: 'core.juce-route',
                });
                return 'rejected';
            }
            if (_isStale(songAudio)) return 'stale';
            const dur = await juceApi.getBackingDuration();
            await juceApi.seekBacking(pos);
            // Start the new transport BEFORE committing global routing state, so
            // a play() failure can't leave us in "JUCE mode, nothing playing"
            // (the silent-song state this watcher exists to prevent).
            // jucePlayer.play() RETURNS false (it does not throw) when
            // startBacking fails — check the result, don't just await it.
            // A play() failure is a TRANSIENT transport-start issue, not a hard
            // codec reject: throw (rather than returning 'rejected') so the
            // caller's catch path handles it WITHOUT memoising the URL, leaving
            // it free to retry on the next poll. Only 'rejected' is memoised.
            // Re-read isPlaying as late as possible: the user can press Pause
            // during the multi-await fetch/IPC chain above. Starting the JUCE
            // transport off a stale `wasPlaying` snapshot would resume a song
            // the user just paused. Only start it if playback is still wanted.
            if (isPlaying) {
                const started = await jucePlayer.play();
                if (started === false) {
                    if (!_isStale(songAudio) && isPlaying) {
                        try { await audio.play(); } catch (_) { /* ignore */ }
                    }
                    throw new Error('jucePlayer.play() failed (transient transport start)');
                }
            }
            if (_isStale(songAudio)) {
                // Song changed while JUCE was spinning up — undo and bail.
                await jucePlayer.pause().catch(() => {});
                return 'stale';
            }
            if (window.jucePlayer) {
                jucePlayer._dur = dur;
                jucePlayer._pos = pos;
                jucePlayer._pollAt = performance.now();
            }
            window._juceMode = true;
            window._juceAudioUrl = url;
            const _spSlider = document.getElementById?.('speed-slider');
            if (_spSlider) setSpeed(_spSlider.value / 100);
            audio.src = '';
            try {
                const apply = window.feedBack?.audio?.applySongVolume;
                if (typeof apply === 'function') await apply();
            } catch (_) { /* best-effort */ }
            console.log('[juce-reroute] HTML5 → JUCE @', pos.toFixed(2), 's playing=', wasPlaying);
            window.feedBack?.playback?.recordRouteChange?.({
                routeKind: 'desktop-native',
                state: 'active',
                preservedTime: true,
                safeReason: 'desktop audio route active',
                requesterId: 'core.juce-route',
            });
            return 'switched';
        } catch (err) {
            // Path lookup, JSON parse, or a JUCE IPC call threw partway through.
            // audio.pause() already ran above; restore HTML5 playback so a
            // previously playing song isn't left silently paused, then re-throw
            // so the caller logs it. The caller does NOT memoise this URL —
            // transient failures must retry on the next poll.
            if (isPlaying && !window._juceMode && !_isStale(songAudio)) {
                if (!audio.src) { audio.src = url; audio.load(); }
                try { await audio.play(); } catch (_) { /* ignore */ }
            }
            window.feedBack?.playback?.recordRouteChange?.({
                routeKind: 'browser-media',
                state: 'degraded',
                preservedTime: true,
                safeReason: 'desktop audio route failed; kept browser media route',
                requesterId: 'core.juce-route',
            });
            throw err;
        } finally {
            // Clearing audio.src above dispatches a 'pause' event in a later
            // task, after this synchronous finally. Defer the refcount
            // decrement so that trailing event is still suppressed; a 0ms
            // timeout lands after the pending pause-event task. Decrementing
            // (rather than zeroing) leaves any overlapping reroute's own
            // suppression intact.
            setTimeout(() => {
                window._juceRerouteInProgress = Math.max(
                    0, (window._juceRerouteInProgress || 1) - 1);
            }, 0);
        }
    }

    async function _switchJuceToHtml5(songAudio) {
        const url = songAudio.url;
        const wasPlaying = isPlaying;
        const pos = (window.jucePlayer ? jucePlayer.currentTime : 0) || 0;
        window.feedBack?.playback?.recordRouteChange?.({
            routeKind: 'browser-media',
            state: 'switching',
            preservedTime: true,
            safeReason: 'desktop audio engine stopped',
            requesterId: 'core.juce-route',
        });
        // Mark a reroute in progress (refcount) so the <audio> 'play' listener
        // suppresses its song:play emission — the migration is transparent and
        // playback genuinely continues, so plugin state must not flip. Held
        // until after the (possibly deferred) audio.play() event has fired.
        window._juceRerouteInProgress = (window._juceRerouteInProgress || 0) + 1;
        let _suppressionReleased = false;
        const _releaseSuppression = () => {
            if (_suppressionReleased) return;
            _suppressionReleased = true;
            // Defer so the 'play' (or 'pause') event task fires while still
            // suppressed; a 0ms timeout lands after it.
            setTimeout(() => {
                window._juceRerouteInProgress = Math.max(
                    0, (window._juceRerouteInProgress || 1) - 1);
            }, 0);
        };
        let _resumeScheduled = false;
        try {
            await jucePlayer.pause().catch(() => {});
            if (_isStale(songAudio)) return;           // song changed mid-pause
            window._juceMode = false;
            window._juceAudioUrl = null;
            audio.src = url;
            audio.load();
            const _spSlider = document.getElementById?.('speed-slider');
            if (_spSlider) setSpeed(_spSlider.value / 100);
            // Resume only AFTER the seek so playback starts at `pos`, not at 0
            // with an audible jump once metadata arrives.
            const resumeAtPos = () => {
                try {
                    // The metadata event can land after a fast song switch —
                    // bail before touching currentTime so a stale callback
                    // doesn't seek the newly loaded song to the old position.
                    if (_isStale(songAudio)) return;
                    try { audio.currentTime = pos; } catch (_) { /* ignore */ }
                    // Re-read isPlaying (not the entry snapshot): the user may
                    // have pressed Pause during jucePlayer.pause()/metadata
                    // load — don't resume a song they just paused.
                    if (isPlaying) {
                        audio.play().catch(() => { /* ignore */ });
                    }
                } finally {
                    _releaseSuppression();
                }
            };
            _resumeScheduled = true;
            if (audio.readyState >= 1) {
                resumeAtPos();
            } else {
                // Wait for metadata to resume at `pos`. But metadata may never
                // arrive (bad URL, network error) — that would leak the
                // suppression refcount and permanently silence song:play /
                // song:pause. Guard with the element's 'error' event AND a
                // backstop timeout; whichever fires first wins, the others are
                // detached. _releaseSuppression is idempotent regardless.
                let _settled = false;
                const _onMeta = () => { finish(true); };
                const _onErr = () => { finish(false); };
                let _backstop;
                function finish(reachedMetadata) {
                    if (_settled) return;
                    _settled = true;
                    clearTimeout(_backstop);
                    audio.removeEventListener('loadedmetadata', _onMeta);
                    audio.removeEventListener('error', _onErr);
                    if (reachedMetadata) {
                        resumeAtPos();             // resumeAtPos releases suppression
                    } else {
                        _releaseSuppression();     // no resume — just release
                    }
                }
                audio.addEventListener('loadedmetadata', _onMeta, { once: true });
                audio.addEventListener('error', _onErr, { once: true });
                // 10s is well beyond a normal local-file metadata load.
                _backstop = setTimeout(() => { finish(false); }, 10000);
            }
        } finally {
            // resumeAtPos owns the release once scheduled; if we returned
            // early (stale, before scheduling) release here instead.
            // _releaseSuppression is idempotent so an overlap is harmless.
            if (!_resumeScheduled) _releaseSuppression();
        }
        try {
            const apply = window.feedBack?.audio?.applySongVolume;
            if (typeof apply === 'function') await apply();
        } catch (_) { /* best-effort */ }
        console.log('[juce-reroute] JUCE → HTML5 @', pos.toFixed(2), 's playing=', wasPlaying);
        window.feedBack?.playback?.recordRouteChange?.({
            routeKind: 'browser-media',
            state: 'active',
            preservedTime: true,
            safeReason: 'browser media route active',
            requesterId: 'core.juce-route',
        });
    }

    async function _reevaluateJuceRouting() {
        if (_rerouteInFlight) return;
        const songAudio = window._currentSongAudio;
        // /audio/ songs are always JUCE-routable. A feedpak full-mix
        // (single-mix pack, no stems) is routable ONLY under an
        // exclusive-style output — in shared mode it must stay on HTML5 so
        // the stem mixer / WebAudio path keeps working. Sloppak stem URLs
        // are never routable (per-stem mix can't ride a single transport).
        if (!songAudio || (!songAudio.juceEligible && !songAudio.feedpakFullMix)) return;
        // Don't race highway.js's own initial song-load routing: it owns
        // _juceMode until _juceRoutingPromise settles. Re-running our switch
        // concurrently would double-call loadBackingTrack for the same URL.
        if (window._highwayJuceRoutingPending) return;

        // Claim the in-flight guard SYNCHRONOUSLY, before the first await. The
        // watcher is driven by a 350ms setInterval; if isAudioRunning() (or any
        // later await) stalls past the poll period, a second tick would
        // otherwise pass the `if (_rerouteInFlight) return` check above and run
        // a concurrent switch — duplicate loadBackingTrack IPCs racing on
        // _juceMode / audio.src. Setting it here closes that window.
        _rerouteInFlight = true;
        try {
            let running;
            try { running = await juceApi.isAudioRunning(); }
            catch (_) { return; }
            if (_isStale(songAudio)) return;               // song changed during IPC
            // Eligibility is evaluated per tick, not snapshotted at song load:
            // the output share mode can change mid-song (device switch in the
            // Audio Engine panel), and a feedpak full-mix must follow it —
            // exclusive → ride the engine; back to shared → return to HTML5.
            let eligible = !!songAudio.juceEligible;
            if (!eligible && songAudio.feedpakFullMix && running) {
                eligible = await _outputIsExclusive();
                if (_isStale(songAudio)) return;           // song changed during IPC
            }
            const wantJuce = !!(running && eligible);
            // [feedpak-route] diagnostics: one line per decision change (the
            // watcher polls at 350ms; steady state must not spam the buffer).
            const _decision = 'running=' + running + ' eligible=' + eligible
                + ' feedpakFullMix=' + !!songAudio.feedpakFullMix
                + ' juceMode=' + !!window._juceMode + ' url=' + songAudio.url;
            if (_decision !== window._lastFeedpakRouteDecision) {
                window._lastFeedpakRouteDecision = _decision;
                console.log('[feedpak-route] watcher:', _decision);
            }
            if (wantJuce === !!window._juceMode) return;   // routing already consistent
            // Don't keep retrying a track JUCE explicitly rejected.
            if (wantJuce && songAudio.url === _rerouteRejectedUrl) return;

            if (wantJuce) {
                const outcome = await _switchHtml5ToJuce(songAudio);
                // Memoise ONLY an explicit hard JUCE reject. A successful
                // switch clears the memo; a 'stale' abort (song changed
                // mid-flight) leaves it untouched — it must never be
                // misclassified as a reject, even if the song object was
                // swapped and then restored before this point.
                if (outcome === 'rejected') {
                    _rerouteRejectedUrl = songAudio.url;
                } else if (outcome === 'switched') {
                    _rerouteRejectedUrl = null;
                }
                // outcome === 'stale': leave _rerouteRejectedUrl as-is.
            } else {
                await _switchJuceToHtml5(songAudio);
                // The engine stopped (or a feedpak's output left exclusive
                // mode). Clear any hard-reject memo so a later engine restart
                // or mode change re-evaluates the track at least once — the
                // rejection may have been a transient device/decoder state.
                _rerouteRejectedUrl = null;
            }
        } catch (e) {
            // Transient failure — log but do NOT memoise, so the next poll retries.
            console.warn('[juce-reroute] re-route failed (will retry):', e);
        } finally {
            _rerouteInFlight = false;
        }
    }
    window._reevaluateJuceRouting = _reevaluateJuceRouting;

    // Clears the hard-reject memo. Called from the song-teardown sites that
    // null window._currentSongAudio (showScreen, playSong) so that reloading
    // the same file later gets a fresh routing attempt — a prior reject may
    // have been a transient JUCE/device state, not a permanent codec issue.
    window._clearJuceRerouteMemo = function () { _rerouteRejectedUrl = null; };

    // The engine can be started/stopped from several places (the desktop Audio
    // Engine panel, the audio_engine plugin, note_detect) and via setDevice
    // restarts — and the contextBridge api object is frozen, so its methods
    // can't be wrapped. Poll isAudioRunning() while a song is loaded; the check
    // is a cheap IPC boolean and no-ops once routing is already consistent.
    // Skip the poll while the document is hidden (background tab / minimised
    // window) — engine toggles there will be reconciled on the first poll
    // after the tab is visible again.
    setInterval(() => {
        if (document.hidden) return;
        if (window._currentSongAudio) void _reevaluateJuceRouting();
    }, 350);
})();

// Renderer-audio bus feeder (desktop Phase 2): when the engine holds the
// output endpoint in an exclusive-style mode, Chromium cannot reach the
// device, so any song audio still played by the renderer goes silent. The
// Phase 1 watcher above already migrates what a single-file transport can
// carry (loose /audio/ songs, feedpak full-mixes) onto the native backing
// transport. This feeder covers the rest — the stems plugin's multi-stem
// WebAudio graph, plus <audio>-element songs the native transport could not
// take (e.g. a codec loadBackingTrack rejected).
//
// Mechanism: capture the renderer-side master with an AudioWorklet tap,
// re-point the owning AudioContext at a null sink so it keeps rendering
// without a device, and push ~10 ms chunks over IPC into the engine's
// renderer bus, where they are mixed into the exclusive output like a
// backing track (~10-20 ms added latency on song audio only; the guitar
// monitoring path is untouched). Validated by the fix12 tester spike:
// null-sink rendering works, clocks hold (drift → 0), no overflow.
//
// Docker sphere: window.feedBackDesktop is undefined → this whole block is
// inert. Shared-mode desktop: the bus stays disabled (no double audio) and
// captured contexts keep/regain their default sink.
(function _installRendererBusFeeder() {
    const api = window.feedBackDesktop?.audio;
    if (!api || typeof api.setRendererBus !== 'function'
             || typeof api.pushRendererAudio !== 'function') return;

    const TAP_WORKLET = `
        class FeedbackBusTap extends AudioWorkletProcessor {
            process(inputs) {
                const inp = inputs[0];
                if (inp && inp[0]) {
                    const L = inp[0], R = inp[1] || inp[0];
                    const out = new Float32Array(L.length * 2);
                    for (let i = 0; i < L.length; i++) { out[i*2] = L[i]; out[i*2+1] = R[i]; }
                    this.port.postMessage(out, [out.buffer]);
                }
                return true;
            }
        }
        registerProcessor('feedback-bus-tap', FeedbackBusTap);
    `;
    const _tapModuleUrl = URL.createObjectURL(new Blob([TAP_WORKLET], { type: 'application/javascript' }));
    const _tapModuleLoaded = new WeakSet();   // AudioContexts with the module added

    // One tap per captured graph. `active` gates the push (the worklet keeps
    // running when inactive — it's silent bookkeeping, not audio).
    function _makeTap(ctx) {
        const state = { node: null, active: false, batch: [], batchFrames: 0 };
        state.attach = async (sourceNode) => {
            if (!_tapModuleLoaded.has(ctx)) {
                await ctx.audioWorklet.addModule(_tapModuleUrl);
                _tapModuleLoaded.add(ctx);
            }
            if (!state.node) {
                state.node = new AudioWorkletNode(ctx, 'feedback-bus-tap', { numberOfInputs: 1, channelCount: 2 });
                const BATCH = Math.round(ctx.sampleRate / 100);   // ~10 ms
                state.node.port.onmessage = (e) => {
                    if (!state.active) { state.batch = []; state.batchFrames = 0; return; }
                    state.batch.push(e.data);
                    state.batchFrames += e.data.length / 2;
                    if (state.batchFrames >= BATCH) {
                        const merged = new Float32Array(state.batchFrames * 2);
                        let o = 0;
                        for (const c of state.batch) { merged.set(c, o); o += c.length; }
                        api.pushRendererAudio(merged, ctx.sampleRate);
                        state.batch = []; state.batchFrames = 0;
                    }
                };
            }
            sourceNode.connect(state.node);
            // No onward connection: the tap is a sink-side observer; audibility
            // in shared mode comes from the graph's own destination path.
        };
        state.detach = (sourceNode) => {
            state.active = false;
            state.batch = []; state.batchFrames = 0;
            if (state.node && sourceNode) {
                try { sourceNode.disconnect(state.node); } catch (_) { /* already gone */ }
            }
        };
        return state;
    }

    // ── Core <audio> element capture ─────────────────────────────────────────
    // createMediaElementSource permanently reroutes the element into its
    // context, so it is created lazily — only the first time an exclusive
    // device actually needs it — and never torn down. From then on the element
    // always plays through _elCtx; sink toggling routes it to the speakers
    // (shared mode) or the null sink + bus (exclusive mode).
    let _elCtx = null, _elSource = null, _elTap = null;
    async function _ensureElementCapture() {
        if (_elCtx) return;
        const el = document.getElementById('audio');
        if (!el) throw new Error('no core audio element');
        // Assign the module state ONLY after the whole chain succeeded.
        // createMediaElementSource throws InvalidStateError when another
        // consumer (highway_3d's analyser tap) already owns the element's
        // one-shot source — assigning _elCtx before that throw poisoned every
        // later tick into `_elTap.active` TypeErrors (tester log 2026-07-11)
        // while the song kept playing on the default device.
        const ctx = new AudioContext();
        let source, tap;
        try {
            source = ctx.createMediaElementSource(el);
            source.connect(ctx.destination);
            tap = _makeTap(ctx);
            await tap.attach(source);
        } catch (e) {
            try { await ctx.close(); } catch (_) { /* already closed */ }
            throw e;
        }
        _elCtx = ctx; _elSource = source; _elTap = tap;
    }

    // ── Whole-app loopback capture ───────────────────────────────────────────
    // Preferred mode: one getDisplayMedia frame-audio capture covers EVERY
    // sound the app makes (song, previews, UI) — no per-surface taps, so
    // plugin-private AudioContexts (song-preview, future plugins) survive
    // exclusive/ASIO output too. The desktop main process answers the request
    // with this window's own frame (frame-scoped — no other apps' audio).
    // Local playback is silenced via the suppressLocalAudioPlayback track
    // constraint, with a page-mute IPC fallback (capture taps frame audio
    // before the output mute, so a muted page still feeds the stream).
    let _lbStream = null, _lbCtx = null, _lbTap = null, _lbPageMuted = false;
    let _loopbackUnavailable = false;   // sticky: probe once, then fall back
    async function _engageLoopback() {
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: { suppressLocalAudioPlayback: true },
        });
        for (const t of stream.getVideoTracks()) t.stop();   // required, unused
        const track = stream.getAudioTracks()[0];
        if (!track) {
            for (const t of stream.getTracks()) t.stop();
            throw new Error('no loopback audio track');
        }
        try {
            _lbCtx = _lbCtx || new AudioContext();
            if (_lbCtx.state !== 'running') await _lbCtx.resume().catch(() => {});
            const source = _lbCtx.createMediaStreamSource(stream);
            const tap = _makeTap(_lbCtx);
            await tap.attach(source);
            const suppressed = track.getSettings?.().suppressLocalAudioPlayback === true;
            if (!suppressed && typeof api.setPageMuted === 'function') {
                _lbPageMuted = (await api.setPageMuted(true)) === true;
            }
            if (window._asioDiagEnabled?.()) {
                console.log('[asio-diag] loopback: suppressed=', suppressed,
                    'pageMuted=', _lbPageMuted, 'rate=', _lbCtx.sampleRate);
            }
            await api.setRendererBus(true, 1.0);
            tap.active = true;
            _lbStream = stream; _lbTap = tap;
            _mode = 'loopback';
            console.log('[renderer-bus] engaged: app loopback → engine bus');
        } catch (e) {
            for (const t of stream.getTracks()) t.stop();
            throw e;
        }
    }
    async function _teardownLoopback() {
        if (_lbTap) _lbTap.active = false;
        if (_lbStream) for (const t of _lbStream.getTracks()) t.stop();
        _lbStream = null; _lbTap = null;
        if (_lbPageMuted && typeof api.setPageMuted === 'function') {
            try { await api.setPageMuted(false); } catch (_) { /* engine gone */ }
        }
        _lbPageMuted = false;
    }

    // ── Engagement state machine ─────────────────────────────────────────────
    // 'off' | 'loopback' | 'element' | 'stems' (element/stems = fallback when
    // loopback capture is unavailable: old desktop main, denied capture)
    let _mode = 'off';
    let _stemsGraph = null;   // { context, masterNode } snapshot while engaged
    let _stemsTap = null;
    const _stemsTaps = new WeakMap();  // context → tap (stems ctx is reused across songs)
    let _busy = false;

    async function _setSink(ctx, exclusive) {
        if (typeof ctx.setSinkId !== 'function') throw new Error('setSinkId unsupported');
        await ctx.setSinkId(exclusive ? { type: 'none' } : '');
        if (ctx.state !== 'running') await ctx.resume().catch(() => {});
        // [asio-diag] a context left on the default sink while the bus is
        // engaged is exactly the "song on the wrong device" symptom — record
        // every successful sink flip (failures throw and are logged upstream).
        if (window._asioDiagEnabled?.()) {
            console.log('[asio-diag] setSink:', exclusive ? 'null-sink' : 'default',
                'state=', ctx.state, 'rate=', ctx.sampleRate);
        }
    }

    async function _disengage() {
        if (_mode === 'off') return;
        const prev = _mode;
        _mode = 'off';
        try { await api.setRendererBus(false, 0); } catch (_) { /* engine gone */ }
        if (prev === 'loopback') {
            await _teardownLoopback();
        } else if (prev === 'element' && _elCtx) {
            _elTap.active = false;
            await _setSink(_elCtx, false).catch(() => {});
        } else if (prev === 'stems' && _stemsGraph) {
            if (_stemsTap) _stemsTap.detach(_stemsGraph.masterNode);
            await _setSink(_stemsGraph.context, false).catch(() => {});
            _stemsGraph = null; _stemsTap = null;
        }
        console.log('[renderer-bus] disengaged (' + prev + ')');
    }

    async function _engageStems(graph) {
        await _setSink(graph.context, true);
        let tap = _stemsTaps.get(graph.context);
        if (!tap) { tap = _makeTap(graph.context); _stemsTaps.set(graph.context, tap); }
        await tap.attach(graph.masterNode);
        await api.setRendererBus(true, 1.0);
        tap.active = true;
        _stemsGraph = graph; _stemsTap = tap;
        _mode = 'stems';
        console.log('[renderer-bus] engaged: stems graph → engine bus');
    }

    async function _engageElement() {
        await _ensureElementCapture();
        await _setSink(_elCtx, true);
        await api.setRendererBus(true, 1.0);
        _elTap.active = true;
        _mode = 'element';
        console.log('[renderer-bus] engaged: <audio> element → engine bus');
    }

    async function _reevaluate() {
        if (_busy) return;
        _busy = true;
        try {
            let running = false, exclusive = false;
            try {
                running = await api.isAudioRunning();
            } catch (_) { /* engine unreachable → treat as not running */ }
            if (running) {
                // Reuse the Phase 1 predicate installed by the routing watcher
                // (getCurrentDevice + exclusive-type check with change-logged
                // diagnostics). Fail closed if it is somehow absent.
                exclusive = !!(await window._juceOutputIsExclusive?.());
            }

            // The stems plugin publishes its live graph while a multi-stem
            // song is loaded (and removes it on teardown).
            const stems = (window.feedBack || window.slopsmith)?.stems?.audioGraph || null;
            // Element songs: a song is loaded, it is NOT riding the native
            // transport (Phase 1 owns those), and the stems graph is not the
            // player. Covers native-transport rejects (codec) in exclusive
            // mode — without this they would be silent.
            const songAudio = window._currentSongAudio;
            const elementSong = !!songAudio && !window._juceMode && !stems;

            let want = 'off';
            if (running && exclusive) {
                // Loopback covers ALL app audio (song, previews, UI), so it
                // engages for the whole exclusive session — not just while a
                // song is loaded. Per-surface modes remain as fallback when
                // loopback capture is unavailable (old desktop main without
                // the display-media handler, capture denied).
                if (!_loopbackUnavailable) want = 'loopback';
                else if (stems) want = 'stems';
                else if (elementSong) want = 'element';
            }
            // Song audio riding the native transport must not ALSO ride the
            // loopback (double-carry into the same engine output). The native
            // transport plays from the engine, not the page, so page loopback
            // never hears it — no conflict; loopback stays engaged for
            // previews/UI while the transport owns the song.

            // [asio-diag] full decision vector, change-gated (500ms poll —
            // steady state must not flood the buffer). This is the feeder-side
            // counterpart of the watcher's [feedpak-route] decision line: it
            // shows WHY the bus did or didn't engage (exclusive predicate,
            // stems graph presence, native transport ownership, element song).
            if (window._asioDiagEnabled?.()) {
                const d = 'running=' + running + ' exclusive=' + exclusive
                    + ' stems=' + !!stems + ' songAudio=' + !!songAudio
                    + ' juceMode=' + !!window._juceMode
                    + ' elementSong=' + elementSong
                    + ' loopbackUnavailable=' + _loopbackUnavailable
                    + ' want=' + want + ' mode=' + _mode;
                if (d !== window._lastRendererBusDecision) {
                    window._lastRendererBusDecision = d;
                    console.log('[asio-diag] renderer-bus:', d);
                }
            }


            const stemsGraphChanged = _mode === 'stems' && stems !== _stemsGraph;
            if (want !== _mode || stemsGraphChanged) {
                await _disengage();
                try {
                    if (want === 'loopback') await _engageLoopback();
                    else if (want === 'stems') await _engageStems(stems);
                    else if (want === 'element') await _engageElement();
                } catch (e) {
                    if (want === 'loopback') {
                        // Capture unavailable (no handler in an old desktop
                        // main, permission denied) — remember and fall back to
                        // the per-surface modes on the next tick.
                        _loopbackUnavailable = true;
                        console.warn('[renderer-bus] loopback capture unavailable — falling back to surface taps:', e);
                    }
                    throw e;
                }
            }
        } catch (e) {
            console.warn('[renderer-bus] reevaluate failed (will retry):', e);
            _mode = 'off';
            // A partial engage may have left the bus enabled with no producer
            // and the page muted — undo both so a failed tick can't strand
            // audio in silence until the next successful engage.
            try { await api.setRendererBus(false, 0); } catch (_) { /* engine gone */ }
            await _teardownLoopback().catch(() => {});
        } finally {
            _busy = false;
        }
    }

    // Same cadence/rationale as the routing watcher above. Also re-check on
    // visibility return so a device switch made while hidden is reconciled.
    setInterval(() => { if (!document.hidden) void _reevaluate(); }, 500);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void _reevaluate(); });
    window._reevaluateRendererBus = _reevaluate;
})();

// Desktop JUCE backing uses an empty <audio> element; plugins such as Section Map
// still seek via audio.currentTime / pause / play. Mirror those onto jucePlayer
// while _juceMode is active. Same-tick pause+seek coalesce into a single seek
// (no stopBacking before seek — HTML5 needed that for buffering; JUCE does not).
let _resetJuceAudioShimChain = function () {};
(function _installJuceAudioElementShim() {
    if (!window.feedBackDesktop?.audio) return;

    const mediaProto = HTMLMediaElement.prototype;
    const ctDesc = Object.getOwnPropertyDescriptor(mediaProto, 'currentTime');
    const pausedDesc = Object.getOwnPropertyDescriptor(mediaProto, 'paused');
    if (!ctDesc?.get || !ctDesc?.set || !pausedDesc?.get) return;

    const nativePlay = mediaProto.play;
    const nativePause = mediaProto.pause;

    let chain = Promise.resolve();
    /** Same-tick pause + seek (Section Map): coalesce to one seek — no stopBacking before seek. */
    let _juceShimBatch = null;
    let _juceShimBatchFlushScheduled = false;
    let _juceShimGen = 0;
    function enqueue(fn) {
        const gen = _juceShimGen;
        const p = chain.then(async () => {
            if (gen !== _juceShimGen) return;
            return fn(gen);
        });
        chain = p.catch((e) => {
            console.warn('[juce-audio-shim]', e);
        });
        return p;
    }
    // forUpcomingPlay: caller will enqueue a play() right after, so don't
    // emit pause-state side effects for a wantsPause batch — play() will
    // overwrite them anyway.
    function flushJuceShimBatchNow({ forUpcomingPlay = false } = {}) {
        _juceShimBatchFlushScheduled = false;
        const batch = _juceShimBatch;
        _juceShimBatch = null;
        if (!batch || !window._juceMode) return;
        const wantsPause = !!batch.wantsPause;
        const seekTime = batch.seekTime;
        if (wantsPause && seekTime !== undefined) {
            enqueue(async (gen) => {
                const r = await _audioSeek(seekTime, 'audio-element-shim');
                if (!r.completed) return; // seek cancelled by teardown
                if (gen !== _juceShimGen) return;
                if (!forUpcomingPlay) {
                    await jucePlayer.pause();
                    if (gen !== _juceShimGen) return;
                    isPlaying = false;
                    setPlayButtonState(false);
                    const sm = window.feedBack;
                    if (sm) {
                        sm.isPlaying = false;
                        sm.emit('song:pause', _songEventPayload());
                    }
                }
                audio.dispatchEvent(new Event('seeked'));
            });
            return;
        }
        if (wantsPause) {
            enqueue(async (gen) => {
                await jucePlayer.pause();
                if (gen !== _juceShimGen) return;
                isPlaying = false;
                setPlayButtonState(false);
                const sm = window.feedBack;
                if (sm) {
                    sm.isPlaying = false;
                    sm.emit('song:pause', _songEventPayload());
                }
            });
            return;
        }
        if (seekTime !== undefined) {
            enqueue(async (gen) => {
                const r = await _audioSeek(seekTime, 'audio-element-shim');
                if (!r.completed) return; // seek cancelled by teardown
                if (gen !== _juceShimGen) return;
                audio.dispatchEvent(new Event('seeked'));
            });
        }
    }
    function scheduleJuceShimBatchFlush() {
        if (_juceShimBatchFlushScheduled) return;
        _juceShimBatchFlushScheduled = true;
        const flushGen = _juceShimGen;
        queueMicrotask(() => {
            if (flushGen !== _juceShimGen) {
                _juceShimBatchFlushScheduled = false;
                return;
            }
            flushJuceShimBatchNow();
        });
    }
    _resetJuceAudioShimChain = function () {
        chain = Promise.resolve();
        _juceShimBatch = null;
        _juceShimBatchFlushScheduled = false;
        _juceShimGen++;
    };

    Object.defineProperty(audio, 'currentTime', {
        get() {
            if (window._juceMode) return jucePlayer.currentTime;
            return ctDesc.get.call(this);
        },
        set(v) {
            if (window._juceMode) {
                const t = Math.max(0, Number(v) || 0);
                _juceShimBatch = _juceShimBatch || {};
                _juceShimBatch.seekTime = t;
                scheduleJuceShimBatchFlush();
                return;
            }
            ctDesc.set.call(this, v);
        },
        configurable: true,
    });

    Object.defineProperty(audio, 'paused', {
        get() {
            if (window._juceMode) return !isPlaying;
            return pausedDesc.get.call(this);
        },
        configurable: true,
    });

    audio.pause = function () {
        if (window._juceMode) {
            _juceShimBatch = _juceShimBatch || {};
            _juceShimBatch.wantsPause = true;
            scheduleJuceShimBatchFlush();
            return;
        }
        nativePause.call(audio);
    };

    audio.play = function () {
        if (window._juceMode) {
            if (_juceShimBatch != null) flushJuceShimBatchNow({ forUpcomingPlay: true });
            const p = enqueue(async (gen) => {
                const started = await jucePlayer.play();
                if (gen !== _juceShimGen || !started) return;
                isPlaying = true;
                setPlayButtonState(true);
                const sm = window.feedBack;
                if (sm) {
                    sm.isPlaying = true;
                    const payload = _songEventPayload();
                    sm.emit('song:play', payload);
                    sm.emit('song:resume', payload);
                }
            });
            return p.then(() => undefined);
        }
        return nativePlay.call(audio);
    };
})();

function _audioTime() { return window._juceMode ? jucePlayer.currentTime : audio.currentTime; }
function _audioDuration() { return window._juceMode ? jucePlayer.duration : audio.duration; }
// Canonical payload for song:play/song:pause/song:ended. Plugins anchor
// their own clocks against `perfNow` (a monotonic timestamp at the same
// moment audio reports `audioT`) so they don't have to chase the chart
// clock with a follow-up call. `time` is kept as an alias for `audioT`
// because pre-existing plugins read e.detail.time.
function _songEventPayload() {
    const audioT = _audioTime();
    return {
        time: audioT,
        audioT,
        chartT: highway.getTime(),
        perfNow: performance.now(),
    };
}

function _markPlaybackPaused() {
    isPlaying = false;
    setPlayButtonState(false);
    if (window.feedBack) {
        window.feedBack.isPlaying = false;
        window.feedBack.emit('song:pause', _songEventPayload());
    }
}

function _markPlaybackResumed() {
    isPlaying = true;
    setPlayButtonState(true);
    if (window.feedBack) {
        window.feedBack.isPlaying = true;
        const payload = _songEventPayload();
        window.feedBack.emit('song:play', payload);
        window.feedBack.emit('song:resume', payload);
    }
}

function _emitPlaybackStopped(time, screen = 'playback-command') {
    if (window.feedBack) window.feedBack.emit('song:stop', { time: time || 0, screen });
}

function _waitForSongReady(expectedSeekGen, timeoutMs = 10000) {
    if (!window.feedBack || typeof window.feedBack.on !== 'function') return Promise.resolve(false);
    return new Promise(resolve => {
        let timer = null;
        const done = value => {
            if (timer !== null) clearTimeout(timer);
            window.feedBack.off('song:ready', onReady);
            resolve(value);
        };
        const onReady = () => done(expectedSeekGen == null || expectedSeekGen === _audioSeekGen);
        window.feedBack.on('song:ready', onReady);
        timer = setTimeout(() => done(false), timeoutMs);
    });
}
// Serializes seeks so concurrent callers (e.g. user ⏪ during a loop wrap)
// don't interleave their from/to reads — each call captures `from` only
// once the previous seek + emit have completed. The generation token
// lets session teardown invalidate queued seeks so they don't run against
// the new player and emit a stale song:seek.
let _audioSeekChain = Promise.resolve();
let _audioSeekGen = 0;
function _resetAudioSeekState() {
    // Bump the generation — in-flight chain callbacks see the mismatch on
    // their next guard check and short-circuit (no emit, no further state
    // mutation by us). Don't reset the chain head: new seeks must still
    // queue behind the in-flight old seek's IPC so two `jucePlayer.seek()`
    // calls can't race in the JUCE backing engine. The queue drains
    // quickly because each subsequent old-gen step bails on the first
    // guard the moment its predecessor resolves.
    _audioSeekGen++;
}
// Time-box the JUCE IPC so a single hung seek can't block the global
// _audioSeekChain forever (which would freeze every subsequent reposition
// path: seekBy, loop-wrap, jump-fix, shimmed audio.currentTime).
const _JUCE_SEEK_TIMEOUT_MS = 2000;
function _juceSeekWithTimeout(s) {
    let timer;
    const seekP = jucePlayer.seek(s);
    const timeoutP = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('JUCE seek timed out')), _JUCE_SEEK_TIMEOUT_MS);
    });
    // Clear the timer once the race settles either way; without this the
    // pending timeout keeps the event loop alive (and eventually rejects
    // an unawaited promise) even after a successful seek.
    return Promise.race([seekP, timeoutP]).finally(() => clearTimeout(timer));
}
// Resolves to `{ completed, from, to }`:
//   - completed: true if the seek ran to completion and emitted song:seek;
//                false if cancelled by a teardown gen bump (or threw).
//   - from: chart clock just before the seek (NaN on cancel before from-read).
//   - to:   verified post-seek clock (NaN on cancel/throw).
// Callers that fire follow-up work after the seek (count-in, arrangement
// restore, etc.) should check `completed` so they don't act on a torn-down
// session. Callers that need the actual landed position (because JUCE may
// clamp or HTML5 may snap to the seekable range) should read `to` rather
// than re-using the requested `s`.
async function _audioSeek(s, reason) {
    // Single funnel for every audio repositioning. Emits song:seek so
    // plugins (notedetect detection-suppression during seek transients,
    // practice-journal segment tracking) can react to any chart-time
    // jump regardless of which UI path triggered it. `reason` is a
    // free-form short string ('seek-by', 'loop-wrap', 'loop-set',
    // 'arrangement-restore', 'jump-fix') so subscribers can filter.
    const gen = _audioSeekGen;
    _audioSeekChain = _audioSeekChain.then(async () => {
        if (gen !== _audioSeekGen) return { completed: false, from: NaN, to: NaN };
        const from = _audioTime();
        if (window._juceMode) await _juceSeekWithTimeout(s);
        else audio.currentTime = s;
        if (gen !== _audioSeekGen) return { completed: false, from, to: NaN };
        // Read the verified post-seek position rather than the requested `s`
        // so plugins observe the actual clock — JUCE may clamp or roll back,
        // and HTML5 may snap to the nearest seekable range.
        const to = _audioTime();
        // Sync the jump-fix tracker so the next 60Hz tick doesn't see a
        // legitimate far seek (e.g. saved-loop jump > 30s) as a browser
        // bug and revert it.
        lastAudioTime = to;
        // Sync the chart clock too so any song:* emit fired right after
        // _audioSeek resolves (e.g. the auto-resume song:play in
        // changeArrangement) sees an in-sync chartT via _songEventPayload.
        // Without this, chartT lags by one 60Hz tick after a seek.
        if (typeof highway !== 'undefined' && highway && typeof highway.setTime === 'function') {
            highway.setTime(to);
        }
        window.feedBack.emit('song:seek', { from, to, reason: reason || null });
        return { completed: true, from, to };
    }).catch((err) => {
        // Don't let one failed seek poison subsequent ones.
        console.warn('[_audioSeek]', err);
        return { completed: false, from: NaN, to: NaN };
    });
    return _audioSeekChain;
}
let currentFilename = '';

// Plugin context API — lightweight event bus for plugin integration
// Preserve any namespace attached by earlier-loaded scripts (e.g.
// diagnostics.js, feedBack#166) so reassigning the root doesn't drop
// their public APIs. Only `feedBack.diagnostics` exists today, but
// the snapshot pattern is intentional: it keeps app.js the
// authoritative owner of the EventTarget while letting other modules
// hang their surfaces off the same namespace without coordinating
// load order.
const _feedBackExisting = (typeof window.feedBack === 'object' && window.feedBack !== null) ? window.feedBack : null;
const _feedBackBus = (_feedBackExisting
    && typeof _feedBackExisting.addEventListener === 'function'
    && typeof _feedBackExisting.removeEventListener === 'function'
    && typeof _feedBackExisting.dispatchEvent === 'function')
    ? _feedBackExisting
    : new EventTarget();
window.feedBack = Object.assign(_feedBackBus, {
    currentSong: null,
    isPlaying: false,
    _navParams: {},
    navigate(screenId, params) {
        this._navParams = params || {};
        showScreen(screenId);
    },
    getNavParams() {
        const p = this._navParams;
        this._navParams = {};
        return p;
    },
    emit(event, detail) {
        this.dispatchEvent(new CustomEvent(event, { detail }));
    },
    on(event, fn, options) {
        this.addEventListener(event, fn, options);
    },
    off(event, fn, options) { this.removeEventListener(event, fn, options); },
    // Loop API — plugins should never reach for #btn-loop-* directly.
    // The script-scope `setLoop` and `clearLoop` are hoisted so these
    // method bodies resolve them lexically; `getLoop` reads the live
    // loopA/loopB bindings at call time.
    seek(seconds, reason, options) {
        _recordPlaybackBridge('playback.window-feedBack-transport', 'window.feedBack.seek', reason || 'plugin-command');
        return _audioSeek(seconds, reason || 'plugin-command');
    },
    setLoop(a, b, options) {
        _recordPlaybackBridge('playback.loop-api', 'window.feedBack.setLoop', options && options.reason || 'plugin-command');
        return setLoop(a, b, options);
    },
    clearLoop(options) {
        _recordPlaybackBridge('playback.loop-api', 'window.feedBack.clearLoop', options && options.reason || 'plugin-command');
        clearLoop(options);
    },
    getLoop(options) {
        _recordPlaybackBridge('playback.loop-api', 'window.feedBack.getLoop', options && options.reason || 'plugin-command');
        return { loopA, loopB };
    },
});
if (_feedBackExisting && _feedBackExisting !== window.feedBack) {
    for (const key of Object.keys(_feedBackExisting)) {
        if (!(key in window.feedBack)) {
            window.feedBack[key] = _feedBackExisting[key];
        }
    }
}
window.feedback = window.feedBack;
window.slopsmith = window.feedback;

function _playbackApi() {
    return window.feedBack && window.feedBack.playback && window.feedBack.playback.version === 1
        ? window.feedBack.playback
        : null;
}

// Bridge hits are a "this legacy surface is still in use" signal, not a call
// counter — but recordBridgeHit is not cheap (compat-shim bookkeeping, a
// playback:bridge-hit event, and a diagnostics snapshot rebuild per call).
// Plugins legitimately poll read surfaces like window.feedBack.getLoop() from
// HUD ticks (note_detect polled at ~30 Hz), which turned every tick into a
// snapshot serialization on the main thread and saturated the inspector's
// hitCount. Throttle per surface: the first call records immediately, repeats
// within the window are dropped.
const _bridgeRecordLast = new Map();
const _BRIDGE_RECORD_MIN_MS = 5000;
function _recordPlaybackBridge(bridgeId, legacySurface, reason) {
    const playback = _playbackApi();
    if (!playback || typeof playback.recordBridgeHit !== 'function') return;
    const key = `${bridgeId}|${legacySurface}`;
    const now = Date.now();
    const last = _bridgeRecordLast.get(key);
    if (last != null && now - last < _BRIDGE_RECORD_MIN_MS) return;
    _bridgeRecordLast.set(key, now);
    playback.recordBridgeHit({
        bridgeId,
        legacySurface,
        source: 'core.app',
        reason: reason || 'legacy playback surface used',
    });
}

function _currentPlaybackSnapshot() {
    const song = window.feedBack && window.feedBack.currentSong || null;
    const time = _audioTime();
    return {
        currentTime: Number.isFinite(time) ? time : null,
        mediaTime: Number.isFinite(time) ? time : null,
        chartTime: (typeof highway !== 'undefined' && highway && typeof highway.getTime === 'function') ? highway.getTime() : null,
        duration: Number.isFinite(_audioDuration()) ? _audioDuration() : (song && song.duration) || null,
        playbackRate: window._juceMode ? (window.jucePlayer && window.jucePlayer._speed || 1) : audio.playbackRate,
        isPlaying,
        readiness: song ? 'ready' : 'idle',
        routeKind: window._juceMode ? 'desktop-native' : 'browser-media',
        routeState: song || audio.src || window._juceAudioUrl ? 'active' : 'unavailable',
        loopA,
        loopB,
        loop: loopA !== null && loopB !== null ? { startTime: loopA, endTime: loopB, enabled: true, state: 'active' } : { enabled: false, state: 'inactive' },
        currentSong: song ? {
            targetId: song.filename ? `target-${String(song.filename).length}-${String(song.arrangementIndex ?? song.arrangement ?? '').length}` : undefined,
            sourceKind: song.format || 'local',
            format: song.format || 'unknown',
            arrangementRef: song.arrangementIndex != null ? `arrangement-${song.arrangementIndex}` : song.arrangement,
            localDisplay: {
                title: song.title,
                artist: song.artist,
                arrangement: song.arrangementSmartName || song.arrangement,
            },
        } : null,
    };
}

function _installPlaybackTransportAdapter() {
    const playback = _playbackApi();
    if (!playback || typeof playback.registerTransportAdapter !== 'function') return;
    playback.registerTransportAdapter({
        inspect() {
            return _currentPlaybackSnapshot();
        },
        async start(args) {
            const target = args && args.target || {};
            const filename = target.filename || target.id || target.songKey || (target.localDisplay && target.localDisplay.filename) || currentFilename;
            if (!filename) throw new Error('No playback filename available');
            // playSong() and the highway WS decodeURIComponent the filename, so a
            // raw name with a literal '%' (e.g. "Song 50%.sloppak") would throw
            // URIError. Normalize to the encoded form playSong expects: pass it
            // through if it already decodes cleanly, otherwise encode it.
            let playbackFilename = filename;
            try { decodeURIComponent(playbackFilename); }
            catch (_) { playbackFilename = encodeURIComponent(filename); }
            const shouldSeekStart = Number.isFinite(Number(args && args.startTime));
            const expectedSeekGen = _audioSeekGen + 1;
            const ready = shouldSeekStart ? _waitForSongReady(expectedSeekGen) : null;
            await playSong(playbackFilename, args && args.arrangement, { bridge: false });
            const becameReady = ready ? await ready : true;
            if (shouldSeekStart && !becameReady) {
                throw new Error('Playback did not become ready before applying startTime');
            }
            if (shouldSeekStart) {
                await _audioSeek(Number(args.startTime), 'playback-start');
            }
            return _currentPlaybackSnapshot();
        },
        async pause() {
            const wasPlaying = isPlaying;
            if (!window._juceMode && wasPlaying) {
                isPlaying = false;
                window.feedBack.isPlaying = false;
                audio.pause();
                _markPlaybackPaused();
            } else {
                if (window._juceMode) await jucePlayer.pause();
                else audio.pause();
                if (wasPlaying) _markPlaybackPaused();
                else { isPlaying = false; window.feedBack.isPlaying = false; setPlayButtonState(false); }
            }
            return _currentPlaybackSnapshot();
        },
        async resume() {
            if (window._juceMode) {
                const started = await jucePlayer.play();
                if (!started) return { unavailable: true, reason: 'desktop backing transport unavailable' };
                _markPlaybackResumed();
            } else {
                await audio.play();
                isPlaying = true;
                window.feedBack.isPlaying = true;
                setPlayButtonState(true);
            }
            return _currentPlaybackSnapshot();
        },
        async stop() {
            const stopTime = _audioTime();
            const hadPlayableSong = !!audio.src || !!window._juceAudioUrl || isPlaying;
            const wasPlaying = isPlaying;
            if (window._juceMode) await jucePlayer.stop().catch(() => {});
            if (!window._juceMode && wasPlaying) {
                isPlaying = false;
                window.feedBack.isPlaying = false;
                audio.pause();
                _markPlaybackPaused();
            } else {
                // HTML5 only. In JUCE mode jucePlayer.stop() already stopped the
                // engine; the audio.pause() shim would just queue a redundant
                // jucePlayer.pause() and a duplicate (or, when not playing,
                // spurious) song:pause.
                if (!window._juceMode) audio.pause();
                if (wasPlaying) _markPlaybackPaused();
                else { isPlaying = false; window.feedBack.isPlaying = false; setPlayButtonState(false); }
            }
            if (hadPlayableSong) _emitPlaybackStopped(stopTime);
            return _currentPlaybackSnapshot();
        },
        seek({ time, reason }) {
            const seconds = Number(time);
            if (!Number.isFinite(seconds) || seconds < 0) {
                throw new Error(`Invalid seek time: ${time}`);
            }
            return _audioSeek(seconds, reason || 'playback-command');
        },
        setLoop({ startTime, endTime }) {
            return setLoop(startTime, endTime, { emitTransportEvent: false });
        },
        clearLoop() {
            clearLoop({ emitTransportEvent: false });
            return _currentPlaybackSnapshot();
        },
    });
}

_installPlaybackTransportAdapter();

// Initialise volume from persisted preference (matches lefty / invertHighway /
// renderScale / showLyrics convention). The mixer popover (audio-mixer.js)
// owns the UI surface; this just hydrates audio.volume on boot.
function _readSongVolume() {
    try {
        const stored = parseFloat(localStorage.getItem('volume'));
        return Number.isFinite(stored) ? Math.min(100, Math.max(0, stored)) : 80;
    } catch (e) {
        return 80;
    }
}
audio.volume = _readSongVolume() / 100;

function _adjustSongVolume(delta) {
    const audioApi = window.feedBack?.audio;
    if (!audioApi) return;
    const current = audioApi.readSongVolume?.() ?? 80;
    const next = Math.max(0, Math.min(100, Math.round(current + delta)));
    const songFader = audioApi.getFaders?.().find(f => f.id === 'song');
    if (songFader) songFader.setValue(next);
}

// Re-sync audio.volume from the persisted setting whenever a new source
// finishes loading metadata. Belt + suspenders — some combinations of plugin
// audio-graph routing and media-element swaps reset audio.volume to 1.0
// (feedBack#54). Delegates to audio-mixer's readSongVolume when loaded so
// the in-memory fallback (for storage-blocked contexts) is authoritative.
audio.addEventListener('loadedmetadata', () => {
    _applyPreservePitch(audio);
    const applySongVolume = window.feedBack?.audio?.applySongVolume;
    if (typeof applySongVolume === 'function') {
        void applySongVolume();
    } else {
        audio.volume = (window.feedBack?.audio?.readSongVolume?.() ?? _readSongVolume()) / 100;
    }
});

// Debug audio issues
audio.addEventListener('pause', () => {
    // The JUCE engine-reroute watcher pauses the element on purpose mid-migration
    // (and the src='' it does fires a trailing async pause too); don't flag those
    // as unexpected — the watcher holds window._juceRerouteInProgress across it.
    if (isPlaying && !window._juceRerouteInProgress) {
        console.log('Audio paused unexpectedly at', audio.currentTime.toFixed(1));
    }
});
audio.addEventListener('error', (e) => {
    // Ignore errors from empty src (happens during song switch cleanup)
    if (!audio.src || audio.src === window.location.href) return;
    console.error('Audio error:', audio.error?.code, audio.error?.message);
});
audio.addEventListener('stalled', () => console.log('Audio stalled at', audio.currentTime.toFixed(1)));
audio.addEventListener('waiting', () => console.log('Audio waiting/buffering at', audio.currentTime.toFixed(1)));
audio.addEventListener('ended', () => {
    console.log('Audio ended'); isPlaying = false;
    setPlayButtonState(false);
    window.feedBack.isPlaying = false;
    window.feedBack.emit('song:ended', _songEventPayload());
});
audio.addEventListener('timeupdate', () => {
    _emitSongPositionChanged(audio.currentTime, audio.duration || null);
});
audio.addEventListener('play', () => {
    // During a JUCE engine reroute the element is paused/played as a transparent
    // migration step — playback genuinely continues, so don't emit song:play or
    // flip feedBack.isPlaying (the watcher keeps the canonical state itself).
    if (window._juceRerouteInProgress) return;
    window.feedBack.isPlaying = true;
    const payload = _songEventPayload();
    window.feedBack.emit('song:play', payload);
    window.feedBack.emit('song:resume', payload);
});
audio.addEventListener('pause', () => {
    if (!isPlaying) return;
    // Same as above: suppress the song:pause emitted by a reroute's deliberate
    // audio.pause() — the migration is transparent to plugin play-state.
    if (window._juceRerouteInProgress) return;
    window.feedBack.isPlaying = false;
    window.feedBack.emit('song:pause', _songEventPayload());
});

// Screen Wake Lock — keep the display awake while a song is playing so the
// OS screensaver doesn't kick in during windowed-mode playback (only audio +
// the highway animation are active, so the input-idle timer otherwise fires).
// Engaged only while playing (acquire on play/resume, release on
// pause/ended/stop) per issue #686. In a plain browser this uses the W3C
// Screen Wake Lock API; inside feedBack-desktop (Electron) navigator.wakeLock
// is unreliable, so we also drive the native powerSaveBlocker bridge when it
// is exposed — both calls are best-effort and degrade silently elsewhere.
let _screenWakeLock = null;
let _wakeLockPending = false;
// Desired state: true while a song should be keeping the screen awake. This is
// the source of truth that survives the async gap of navigator.wakeLock.request
// — set synchronously by acquire/release so an in-flight request that resolves
// after playback already stopped can release itself instead of leaking a lock.
let _wakeLockWanted = false;
// Set when an acquire is requested while one is already in flight (e.g. a quick
// hide→show during the first request); the in-flight request retries once on
// settle so a transient NotAllowedError doesn't leave the song unprotected.
let _wakeLockRetry = false;
// Last value handed to the desktop bridge. This is the value we *requested*,
// not one confirmed by the IPC round trip: the Electron main-process side
// effect (powerSaveBlocker start/stop) happens when the message is received,
// before its promise resolves, so deduping on the requested value lets opposite
// transitions (true↔false) always go through promptly while still suppressing
// redundant repeats (e.g. the synchronous song:play + song:resume pair). A
// rejected/throwing call invalidates the marker (the side effect never landed)
// so the next song:* / visibilitychange retries — without an inline re-sync,
// which would tight-loop on a persistently failing bridge.
// Last value handed to the bridge: false (off) / true (on) / null (unknown —
// a call failed, so the real blocker state can't be assumed). null never equals
// a boolean `want`, so the next sync always re-sends and recovers.
let _desktopAwakeReq = false;
// Monotonic id of the most recent bridge call, so a stale (out-of-order)
// rejection from a superseded call can be ignored rather than corrupting the
// marker — a boolean alone can't tell "my request failed" from "an older
// same-valued request failed after a newer one already succeeded".
let _desktopAwakeGen = 0;
// Drive the native feedBack-desktop blocker to exactly (wanted && visible),
// mirroring the browser wake lock which is only held while the page is visible.
// Gating on visibility stops a minimized Electron window from keeping the whole
// display awake. No-op in a plain browser; isolated from the wakeLock path so a
// flaky bridge can't abort it.
function _syncDesktopBridge() {
    const want = _wakeLockWanted && document.visibilityState === 'visible';
    if (want === _desktopAwakeReq) return; // already requested this value
    const bridge = window.feedBackDesktop?.power?.setScreenAwake;
    if (typeof bridge !== 'function') return; // plain browser — nothing to sync
    _desktopAwakeReq = want;
    const gen = ++_desktopAwakeGen;
    let r;
    try {
        r = bridge(want);
    } catch (e) {
        console.debug('desktop wake bridge failed:', e?.name || e);
        if (gen === _desktopAwakeGen) _desktopAwakeReq = null; // unknown — force a re-send next event
        return;
    }
    if (r && typeof r.then === 'function') {
        r.catch((e) => {
            console.debug('desktop wake bridge rejected:', e);
            // The IPC didn't take effect; we can't assume which state the blocker
            // is in (a prior call may also have failed), so mark it unknown and
            // let the next song:* / visibilitychange re-send. Only if this is
            // still the latest request — a stale rejection from a superseded call
            // must not clobber a newer request's marker.
            if (gen === _desktopAwakeGen) _desktopAwakeReq = null;
        });
    }
}
async function _acquireWakeLock() {
    _wakeLockWanted = true;
    _syncDesktopBridge();
    if (_screenWakeLock) return; // already held — nothing to do
    // A request is already in flight (song:play and song:resume fire
    // synchronously from the audio 'play' listener, and visibilitychange can
    // re-enter): don't issue a duplicate, but remember to retry on settle so a
    // visibility bounce during the request can't strand us without a lock.
    if (_wakeLockPending) { _wakeLockRetry = true; return; }
    if (!navigator.wakeLock?.request) return;
    _wakeLockPending = true;
    _wakeLockRetry = false;
    try {
        const sentinel = await navigator.wakeLock.request('screen');
        if (!_wakeLockWanted) {
            // Playback stopped while the request was in flight — release the
            // just-granted lock immediately rather than holding it stale.
            try { await sentinel.release(); } catch (e) { /* already released */ }
            return;
        }
        _screenWakeLock = sentinel;
        sentinel.addEventListener('release', () => {
            _screenWakeLock = null;
            // The UA auto-releases on tab hide, but may also release for its own
            // reasons (power policy) while the page stays visible. Re-acquire if
            // a song is still playing and we're visible — the visibilitychange
            // handler covers the hidden→visible case.
            if (_wakeLockWanted && document.visibilityState === 'visible') {
                _acquireWakeLock();
            }
        });
    } catch (e) {
        // NotAllowedError (page hidden / no user activation) or unsupported.
        console.debug('wakeLock request failed:', e?.name || e);
    } finally {
        _wakeLockPending = false;
        // A re-acquire arrived while the request was in flight (typically a
        // hide→show bounce). If we still want the lock, are visible, and didn't
        // get one (the request raced a hidden window and rejected), try once
        // more now that the page state has settled. Bounded: only fires when a
        // bounce actually occurred, so a permanently-denied request can't loop.
        if (_wakeLockRetry && _wakeLockWanted && !_screenWakeLock
            && document.visibilityState === 'visible') {
            _wakeLockRetry = false;
            _acquireWakeLock();
        }
    }
}
async function _releaseWakeLock() {
    _wakeLockWanted = false;
    _syncDesktopBridge();
    if (!_screenWakeLock) return;
    try { await _screenWakeLock.release(); } catch (e) { /* already released */ }
    _screenWakeLock = null;
}
window.feedBack.on('song:play', _acquireWakeLock);
window.feedBack.on('song:resume', _acquireWakeLock);
window.feedBack.on('song:pause', _releaseWakeLock);
window.feedBack.on('song:ended', _releaseWakeLock);
window.feedBack.on('song:stop', _releaseWakeLock);
// A screen wake lock is auto-released whenever the page is hidden; re-sync the
// desktop bridge (off while hidden) and re-acquire the browser lock when we
// become visible again if a song is still playing.
document.addEventListener('visibilitychange', () => {
    _syncDesktopBridge();
    if (document.visibilityState === 'visible' && _wakeLockWanted) {
        _acquireWakeLock();
    }
});

// ── Autoplay & auto-exit (global option, default ON) ──────────────────
// One toggle (`autoplayExit` in localStorage) that (a) auto-starts a song
// once it's ready and (b) returns to the launching menu when the song
// ends. Absence of the key means enabled. The behaviour lives in core
// (app.js, shared by the v3 + classic UIs); the end-of-song *score*
// screen, when present, is a plugin and hooks the contract below.
function _autoplayExitEnabled() {
    try { return localStorage.getItem('autoplayExit') !== '0'; } catch (_) { return true; }
}
// Settings checkbox setter (onchange="setAutoplayExit(this.checked)").
window.setAutoplayExit = function (on) {
    try { localStorage.setItem('autoplayExit', on ? '1' : '0'); } catch (_) { /* private mode */ }
    const el = document.getElementById('setting-autoplay-exit');
    if (el && el.checked !== !!on) el.checked = !!on;
};
// Read-only view for plugins (e.g. a scoring plugin deciding whether to
// auto-return after its results screen closes).
Object.defineProperty(window.feedBack, 'autoplayExit', {
    get: _autoplayExitEnabled, configurable: true,
});

// ── "Up Next" pill (global option, default ON) ────────────────────────
// Gates the v3 player chrome's persistent upcoming-section pill
// (#v3-upnext, driven by player-chrome.js's updateUpNext). Client-only
// localStorage pref (`showUpNext`); absence of the key means enabled.
// player-chrome.js reads window.feedBack.showUpNext each tick and hides
// the pill when off.
function _showUpNextEnabled() {
    try { return localStorage.getItem('showUpNext') !== '0'; } catch (_) { return true; }
}
// Settings checkbox setter (onchange="setShowUpNext(this.checked)").
window.setShowUpNext = function (on) {
    try { localStorage.setItem('showUpNext', on ? '1' : '0'); } catch (_) { /* private mode */ }
    const el = document.getElementById('setting-show-upnext');
    if (el && el.checked !== !!on) el.checked = !!on;
    // Reflect immediately when disabling mid-playback; the chrome's rAF
    // loop (~6 Hz) re-shows it when re-enabled and a section is upcoming.
    if (!on) {
        const pill = document.getElementById('v3-upnext');
        if (pill) pill.classList.add('hidden');
    }
};
// Read-only view for the player chrome (and any plugin) to gate the pill.
Object.defineProperty(window.feedBack, 'showUpNext', {
    get: _showUpNextEnabled, configurable: true,
});

// "Countdown before song" (Gameplay tab). Mirrored to localStorage by
// loadSettings so the song-start path can read it synchronously here — no
// async /api/settings fetch on the play hot path. Defaults off.
function _countdownBeforeSongEnabled() {
    try { return localStorage.getItem('countdownBeforeSong') === '1'; } catch (_) { return false; }
}
// Settings checkbox setter (onchange="setCountdownBeforeSong(this.checked)").
// Writes localStorage for the synchronous read above AND persists to the
// server so it survives a reload / rides along in the settings export bundle.
window.setCountdownBeforeSong = function (on) {
    try { localStorage.setItem('countdownBeforeSong', on ? '1' : '0'); } catch (_) { /* private mode */ }
    const el = document.getElementById('setting-countdown-before-song');
    if (el && el.checked !== !!on) el.checked = !!on;
    persistSetting('countdown_before_song', !!on);
};
// One-shot launcher override for the player's return destination.
window.feedBack.setReturnScreen = function (id) {
    window.feedBack._nextReturnScreen = id || null;
};
// Resolve where the player should return on Esc / close / auto-exit.
// A one-shot setReturnScreen() override wins (consumed here) — used by the
// lessons catalog so a lesson returns to the lessons screen rather than the
// library, even though the external tutorials plugin owns the playSong call.
// Otherwise remember the actual launch screen; the element-exists guard
// keeps the classic v2 UI (no #v3-* ids) from being stranded on a missing
// screen, and unknown launches fall back to 'home'. The dashboard — classic
// 'home' and the v3 shell's 'v3-home' — returns to the Songs list when it
// exists (dashboard actions call playSong() directly, so its id is the
// active screen at launch).
function _resolvePlayerOrigin() {
    const override = window.feedBack && window.feedBack._nextReturnScreen;
    if (window.feedBack) window.feedBack._nextReturnScreen = null;
    if (override && document.getElementById(override)) return override;
    const launchFrom = document.querySelector('.screen.active');
    const launchId = launchFrom && launchFrom.id;
    if (launchId && launchId !== 'player' && document.getElementById(launchId)) {
        return ((launchId === 'home' || launchId === 'v3-home') && document.getElementById('v3-songs'))
            ? 'v3-songs' : launchId;
    }
    return 'home';
}

// Autoplay: one-shot flag armed by each fresh playSong(), consumed by the
// next song:ready. song:ready also fires on arrangement switches / seeks,
// which never arm the flag, so those don't auto-restart.
let _pendingAutostart = false;
// Autoplay gate (window.feedBack.holdAutoplay): a plugin (the tuner) can defer the
// auto-start of a freshly-loaded song until it's cleared — "tune before you play".
// The hold is claimed synchronously on song:loading (so it beats this song:ready
// autostart); release() — or a fail-open backstop — runs the deferred start.
// Generation-guarded so a newer song invalidates a stale hold. Manual Play never
// flows through here, so Play always wins.
let _autoplayHeld = false;
let _autoplayStart = null;
let _autoplayGen = 0;
let _autoplayBackstop = null;
const AUTOPLAY_HOLD_BACKSTOP_MS = 12000;
function _clearAutoplayHold() {
    if (_autoplayBackstop) { clearTimeout(_autoplayBackstop); _autoplayBackstop = null; }
    _autoplayHeld = false;
    _autoplayStart = null;
    _autoplayGen++;
}
function _releaseAutoplay(gen) {
    if (gen !== _autoplayGen) return;            // a newer song superseded this hold
    if (_autoplayBackstop) { clearTimeout(_autoplayBackstop); _autoplayBackstop = null; }
    _autoplayHeld = false;
    const start = _autoplayStart;
    _autoplayStart = null;
    if (typeof start === 'function') start();
}
let _autoplayHoldToken = 0;
window.feedBack.holdAutoplay = function () {
    const gen = _autoplayGen;
    const token = ++_autoplayHoldToken;   // this hold's identity — a stale release from an earlier hold is a no-op
    _autoplayHeld = true;
    if (_autoplayBackstop) clearTimeout(_autoplayBackstop);
    // Fail-open: a hold that's never released (a plugin that claimed but wedged before
    // it could decide) must never permanently block the song. Once the holder commits
    // to an intentional, user-dismissable hold it calls release.settle() to cancel this
    // — so the backstop can't cut off e.g. a user still tuning past the timeout.
    _autoplayBackstop = setTimeout(() => _releaseAutoplay(gen), AUTOPLAY_HOLD_BACKSTOP_MS);
    let released = false;
    function release() {
        if (released || gen !== _autoplayGen || token !== _autoplayHoldToken) return;
        released = true;
        _releaseAutoplay(gen);
    }
    // Cancel the fail-open backstop WITHOUT releasing: the holder has taken explicit
    // responsibility for releasing (on dismiss), and a song switch clears the hold anyway.
    release.settle = function () {
        if (gen !== _autoplayGen || token !== _autoplayHoldToken) return;
        if (_autoplayBackstop) { clearTimeout(_autoplayBackstop); _autoplayBackstop = null; }
    };
    return release;
};
window.feedBack.on('song:ready', () => {
    if (!_pendingAutostart) return;
    _pendingAutostart = false;
    if (isPlaying) return;
    // Feedpak contributor credits: only real feedpak plays carry authors
    // (loose/archive and minigames get []), so a non-empty list is the gate.
    // Shown over the highway and dismissed the moment real playback begins
    // (song:play). This fresh-load path is the only place it fires —
    // arrangement switches / seeks / manual replays never arm _pendingAutostart,
    // and minigames never get here. Decoupled from autoplay below so credits
    // show on load even when autoplay-exit is disabled.
    const authors = (window.feedBack.currentSong && window.feedBack.currentSong.authors) || [];
    if (authors.length) {
        showSongCreditsOverlay(authors);
        _creditsHideOnPlay = () => { _creditsHideOnPlay = null; hideSongCreditsOverlay(); };
        window.feedBack.on('song:play', _creditsHideOnPlay, { once: true });
    }
    // Autoplay-exit disabled: don't auto-start. Still let the credits dwell a
    // couple seconds on the freshly-loaded song, then clear them (they also
    // clear early if the user manually presses Play, via _creditsHideOnPlay).
    if (!_autoplayExitEnabled()) {
        if (authors.length) _creditsTimer = setTimeout(hideSongCreditsOverlay, _CREDITS_HOLD_MS);
        return;
    }
    // The actual auto-start: a count-in (which handles HTML5 + _juceMode) or the
    // Play path directly. Guarded so a manual Play during a gate / credits hold
    // can't double-toggle, and so a stale (released-after-leaving) start never
    // begins playback off the player.
    const start = () => {
        if (isPlaying) return;
        if (!document.getElementById('player')?.classList.contains('active')) { hideSongCreditsOverlay(); return; }
        if (_countdownBeforeSongEnabled()) {
            Promise.resolve(startSongCountIn()).catch((err) => console.warn('[app] song count-in failed:', err));
        } else {
            Promise.resolve(togglePlay())
                .then(() => { if (!isPlaying) hideSongCreditsOverlay(); })
                .catch((err) => { console.warn('[app] autoplay failed:', err); hideSongCreditsOverlay(); });
        }
    };
    // A plugin (the tuner) may gate playback until it's cleared. The hold was
    // claimed on song:loading; stash the start and let release()/the backstop run
    // it. _cancelCountIn()/changeArrangement() clear _creditsTimer below, so a
    // teardown during the credits dwell still cancels a non-gated play.
    if (_autoplayHeld) { _autoplayStart = start; return; }
    // Not gated: a count-in starts now (it owns its on-screen dwell); otherwise
    // let the credits dwell a couple seconds first, then start.
    if (_countdownBeforeSongEnabled() || !authors.length) start();
    else _creditsTimer = setTimeout(() => { _creditsTimer = null; start(); }, _CREDITS_HOLD_MS);
});

// ── Resume last session ────────────────────────────────────────────────────
// Leaving a song snapshots where you were — song, arrangement, position, and
// speed — so an exit (especially an accidental one, now that Escape reliably
// leaves regardless of focus) is recoverable instead of restarting from bar 1.
// The snapshot is offered back through a non-blocking "Resume" pill; it never
// gates, blocks, or auto-acts. Cleared on natural song-end and once consumed.
// (This is the player-session slice; the broader nav/state-resume work — e.g.
// returning to a song after wandering into Settings → Tone Builder — is a
// separate, larger track.)
const _RESUME_KEY = 'feedBack.resumeSession';
const _RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;   // a day-old snapshot is stale
const _RESUME_MIN_POSITION_S = 3;                  // ignore barely-started songs
const _RESUME_END_GUARD_S = 5;                      // ignore basically-finished songs
let _pendingResume = null;                          // {position, speed}, consumed at song:ready
let _resumePillDismissed = false;                   // per-session: user waved off the current snapshot

function _curPlaybackSpeed() {
    try {
        return window._juceMode
            ? ((window.jucePlayer && window.jucePlayer._speed) || 1)
            : (document.getElementById('audio')?.playbackRate || 1);
    } catch (_) { return 1; }
}

// Snapshot the live session. Called from showScreen()'s teardown before
// highway.stop()/audio unload, while getSongInfo() + position are still valid.
function _snapshotResumeSession(position) {
    try {
        if (!currentFilename) return;
        const si = (window.highway && typeof highway.getSongInfo === 'function')
            ? (highway.getSongInfo() || {}) : {};
        const dur = Number(si.duration) || 0;
        const pos = Number(position) || 0;
        // Only worth resuming a song you were genuinely mid-way through — not a
        // glance at the first seconds, and not one that already basically ended.
        if (pos < _RESUME_MIN_POSITION_S) { _clearResumeSession(); return; }
        if (dur && pos > dur - _RESUME_END_GUARD_S) { _clearResumeSession(); return; }
        const snap = {
            f: currentFilename,
            a: (typeof si.arrangement_index === 'number' && si.arrangement_index >= 0)
                ? si.arrangement_index : undefined,
            t: pos,
            sp: _curPlaybackSpeed(),
            title: si.title || '',
            artist: si.artist || '',
            ts: Date.now(),
        };
        localStorage.setItem(_RESUME_KEY, JSON.stringify(snap));
        // A fresh snapshot earns one offer — undo any earlier dismissal.
        _resumePillDismissed = false;
    } catch (_) { /* storage unavailable — resume is best-effort */ }
}

function _readResumeSession() {
    try {
        const raw = localStorage.getItem(_RESUME_KEY);
        if (!raw) return null;
        const snap = JSON.parse(raw);
        if (!snap || !snap.f || !(Number(snap.t) > 0)) return null;
        if (!snap.ts || Date.now() - snap.ts > _RESUME_MAX_AGE_MS) { _clearResumeSession(); return null; }
        return snap;
    } catch (_) { return null; }
}

function _clearResumeSession() {
    try { localStorage.removeItem(_RESUME_KEY); } catch (_) {}
}

// Re-enter the snapshotted song and restore arrangement + position + speed.
async function resumeLastSession() {
    const snap = _readResumeSession();
    if (!snap) { _hideResumePill(); return false; }
    _hideResumePill();
    try {
        await playSong(snap.f, snap.a, {
            resume: { position: Number(snap.t) || 0, speed: Number(snap.sp) || 1 },
        });
    } catch (err) {
        // A transient load/connect failure must not strand the user: keep the
        // snapshot so the pill can re-offer it on the next non-player screen,
        // rather than consuming the only copy before the song actually loaded.
        console.warn('[app] resume failed to load; keeping snapshot:', err);
        _pendingResume = null;
        return false;
    }
    _clearResumeSession();   // consumed only after a successful load
    return true;
}
window.resumeLastSession = resumeLastSession;
if (window.feedBack) window.feedBack.resumeLastSession = resumeLastSession;

// Consume a pending resume once the chart is ready: restore speed, seek to the
// saved position, then (if autoplay is on) start from there. playSong() does
// NOT arm autostart for a resume load, so the two never fight over playback.
window.feedBack.on('song:ready', () => {
    const pend = _pendingResume;
    if (!pend) return;
    _pendingResume = null;
    try {
        if (pend.speed && pend.speed > 0) {
            const slider = document.getElementById('speed-slider');
            if (slider) slider.value = String(Math.round(pend.speed * 100));
            setSpeed(pend.speed);
        }
    } catch (_) { /* speed restore is best-effort */ }
    Promise.resolve(_audioSeek(Math.max(0, Number(pend.position) || 0), 'session-resume'))
        .then(() => { if (_autoplayExitEnabled() && !isPlaying) return togglePlay(); })
        .catch((err) => console.warn('[app] resume failed:', err));
});

// A song that finishes on its own has nothing to resume — and we never want to
// offer "resume" for a song the user just completed.
window.feedBack.on('song:ended', _clearResumeSession);

// ── Resume pill (non-blocking "continue where you left off") ────────────────
// Self-contained, inline-styled, body-appended so it works identically in the
// classic (v2) and v3 shells with no Tailwind rebuild. It only ever appears off
// the player screen, never blocks, and a dismiss forgets the current snapshot
// for the session.
function _hideResumePill() {
    const el = document.getElementById('fb-resume-pill');
    if (el) el.remove();
}

function _maybeShowResumePill() {
    const active = document.querySelector('.screen.active');
    if (active && active.id === 'player') { _hideResumePill(); return; }
    if (_resumePillDismissed) return;
    const snap = _readResumeSession();
    if (!snap) { _hideResumePill(); return; }
    if (document.getElementById('fb-resume-pill')) return;   // already shown

    const label = (snap.title || decodeURIComponent(snap.f || 'your last song')).toString();
    const pill = document.createElement('div');
    pill.id = 'fb-resume-pill';
    pill.setAttribute('role', 'status');
    pill.style.cssText = [
        'position:fixed', 'left:16px', 'bottom:16px', 'z-index:120',
        'display:flex', 'align-items:center', 'gap:10px',
        'max-width:min(90vw,360px)', 'padding:10px 12px',
        'background:rgba(17,24,39,0.96)', 'color:#e5e7eb',
        'border:1px solid rgba(148,163,184,0.25)', 'border-radius:10px',
        'box-shadow:0 6px 24px rgba(0,0,0,0.4)',
        'font:13px/1.3 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
    ].join(';');

    const text = document.createElement('div');
    text.style.cssText = 'flex:1;min-width:0';
    const t1 = document.createElement('div');
    t1.textContent = 'Resume practice';
    t1.style.cssText = 'font-weight:600;color:#fff';
    const t2 = document.createElement('div');
    t2.textContent = label;
    t2.style.cssText = 'opacity:0.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    text.appendChild(t1); text.appendChild(t2);

    const resumeBtn = document.createElement('button');
    resumeBtn.type = 'button';
    resumeBtn.textContent = 'Resume ▸';
    resumeBtn.style.cssText = 'flex:none;padding:6px 10px;border:0;border-radius:7px;background:#4080e0;color:#fff;font-weight:600;cursor:pointer';
    resumeBtn.addEventListener('click', () => { resumeLastSession(); });

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.setAttribute('aria-label', 'Dismiss');
    dismissBtn.textContent = '✕';
    dismissBtn.style.cssText = 'flex:none;padding:4px 6px;border:0;border-radius:7px;background:transparent;color:#9ca3af;cursor:pointer;font-size:14px';
    dismissBtn.addEventListener('click', () => { _resumePillDismissed = true; _hideResumePill(); });

    pill.appendChild(text);
    pill.appendChild(resumeBtn);
    pill.appendChild(dismissBtn);
    (document.body || document.documentElement).appendChild(pill);
}
if (window.feedBack) window.feedBack._maybeShowResumePill = _maybeShowResumePill;

// Exposed for tests/debugging (mirrors window._panels / _getCurrentContext).
window._snapshotResumeSession = _snapshotResumeSession;
window._readResumeSession = _readResumeSession;
window._clearResumeSession = _clearResumeSession;

// Drive the pill off screen transitions (hide over the player, offer it
// elsewhere) plus a one-shot check on first load for a prior-session snapshot.
window.feedBack.on('screen:changed', (ev) => {
    const id = (ev && ev.detail && ev.detail.id) || (ev && ev.id);
    if (id === 'player') _hideResumePill();
    else _maybeShowResumePill();
});
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded',
        () => { try { _maybeShowResumePill(); } catch (_) {} }, { once: true });
} else {
    try { _maybeShowResumePill(); } catch (_) {}
}

// Editor → Highway handoff (Editor ⇄ 3D Highway region round-trip). The
// editor's "Loop in 3D" button stashes a pending loop + return context, then
// calls playSong(). Once the chart is ready (playSong's own clearLoop() has
// already run, so the loop won't be wiped), arm the loop over the selected
// region and start playback so the user lands inside the loop directly.
window.feedBack.on('song:ready', () => {
    _updateEditRegionBtn();
    const pend = window._pendingHighwayLoop;
    if (!pend) return;
    // Only apply to the song it was set for — a cancelled/failed handoff
    // must not arm a stale loop on an unrelated song loaded later.
    const want = pend.returnCtx && pend.returnCtx.filename;
    if (want && currentFilename && want !== currentFilename) return;
    window._pendingHighwayLoop = null;
    window._highwayReturnCtx = pend.returnCtx || null;
    Promise.resolve(setLoop(pend.a, pend.b))
        .then((ok) => { if (ok && !isPlaying) return togglePlay(); })
        .catch((err) => console.warn('[app] loop-in-3d apply failed:', err));
    _updateEditRegionBtn();
});

// Auto-exit: when the song ends, return to the launching menu. A scoring
// plugin that shows an end-of-song results screen calls holdAutoExit() to
// defer this; the user closing that screen (its Close button calls
// window.closeCurrentSong()) performs the exit. With no results screen the
// grace timer returns to the menu on its own.
const AUTO_EXIT_GRACE_MS = 1500;
let _autoExitTimer = null;
let _autoExitHeld = false;
// Bumped every time the auto-exit state is reset (new song via playSong, and
// each song:ended). A hold's release() captures the generation at hold time
// and no-ops once it changes, so a plugin that drops or fires its release
// handle after the player has moved on can never navigate a fresh session —
// callers don't need to balance the handle.
let _autoExitGen = 0;
function _clearAutoExit() {
    if (_autoExitTimer) { clearTimeout(_autoExitTimer); _autoExitTimer = null; }
    _autoExitHeld = false;
    _autoExitGen++;
}
// Heuristic safety net for score-screen plugins that don't (yet) call
// holdAutoExit(): if a visible full-screen results/dialog overlay is on top
// when the grace timer fires, defer the auto-return and let that screen's
// own close button drive the exit (its Close should call closeCurrentSong).
// getClientRects() is used for the visibility test because it reports
// position:fixed overlays correctly, unlike offsetParent.
function _resultsOverlayVisible() {
    let nodes;
    try {
        nodes = document.querySelectorAll('[role="dialog"][aria-modal="true"], .fixed.inset-0');
    } catch (_) { return false; }
    for (const el of nodes) {
        if (!el || el.id === 'player') continue;            // never the player itself
        if (el.classList && el.classList.contains('hidden')) continue;
        if (el.getClientRects && el.getClientRects().length > 0) return true;
    }
    return false;
}
// Plugins call this synchronously from their own song:ended handler (core
// runs first, so the timer is already pending) to claim the exit.
window.feedBack.holdAutoExit = function () {
    if (_autoExitTimer) { clearTimeout(_autoExitTimer); _autoExitTimer = null; }
    _autoExitHeld = true;
    const gen = _autoExitGen;
    let released = false;
    return function release() {
        // No-op once released, or once the session has moved on (a newer
        // playSong / song:ended bumped the generation) — so a stale handle
        // never navigates away from a fresh song.
        if (released || gen !== _autoExitGen) return;
        released = true;
        if (typeof window.closeCurrentSong === 'function') window.closeCurrentSong();
    };
};
window.feedBack.on('song:ended', () => {
    _clearAutoExit();
    if (!_autoplayExitEnabled()) return;
    // Only auto-exit from the player screen (ignore stale/duplicate ends).
    const active = document.querySelector('.screen.active');
    if (!active || active.id !== 'player') return;
    _autoExitTimer = setTimeout(() => {
        _autoExitTimer = null;
        if (_autoExitHeld) return;            // a plugin explicitly claimed the exit
        if (_resultsOverlayVisible()) return; // a score/results overlay is up; let it drive the exit
        const cur = document.querySelector('.screen.active');
        if (cur && cur.id === 'player' && typeof window.closeCurrentSong === 'function') {
            window.closeCurrentSong();
        }
    }, AUTO_EXIT_GRACE_MS);
});

// Abort controller for cancelling pending requests when entering player
let artAbortController = null;

async function playSong(filename, arrangement, options) {
    console.log('playSong called:', filename);
    // A manual (non-queue) play abandons any active play-queue, so a stale queue
    // can't hijack the next song's end. The queue passes fromQueue to keep itself.
    if ((!options || !options.fromQueue) && window.feedBack && window.feedBack.playQueue) {
        window.feedBack.playQueue.clear();
    }
    if (!options || options.bridge !== false) {
        _recordPlaybackBridge('playback.window-play-song', 'window.playSong', 'legacy playSong entry point used');
    }
    // Invalidate any prior song's autoplay gate before plugins re-claim it on the
    // song:loading emit below.
    _clearAutoplayHold();
    window.feedBack.emit('song:loading', { filename, arrangement: arrangement ?? null });

    // Cancel any pending art/metadata requests
    if (artAbortController) artAbortController.abort();
    artAbortController = null;

    highway.stop();
    // Cancel any active count-in: clear timers/RAF and bump the gen so
    // delayed callbacks (rewind frames, post-seek then, count-in ticks,
    // post-count play) bail before mutating the new session.
    _cancelCountIn();
    // Reset the JUCE shim BEFORE awaiting jucePlayer.stop() so any in-flight
    // shim closures see a stale generation after their await and bail out
    // before mutating isPlaying / button label / song:* events for the
    // outgoing song.
    _resetJuceAudioShimChain();
    // Cancel queued _audioSeek calls from the previous song: bumping the
    // generation makes their chained callbacks bail out.
    _resetAudioSeekState();
    if (window._juceMode) {
        // Mirror the showScreen teardown: emit song:pause for the JUCE
        // path so plugins don't see a stale "playing" state on song
        // change. (HTML5 fires it via the audio element 'pause' event.)
        // Snapshot payload BEFORE stop() resets _pos so audioT/chartT
        // capture the actual paused position.
        const payload = _songEventPayload();
        const wasPlaying = isPlaying;
        await jucePlayer.stop().catch(() => {});
        if (wasPlaying && window.feedBack) {
            window.feedBack.isPlaying = false;
            window.feedBack.emit('song:pause', payload);
        }
        window._juceMode = false;
        window._juceAudioUrl = null;
    }
    audio.pause();
    audio.src = '';
    // Stale until the incoming song's WS handler (highway.js) sets it again.
    window._currentSongAudio = null;
    // Fresh JUCE routing attempt for whatever song loads next.
    window._clearJuceRerouteMemo?.();
    isPlaying = false;
    setPlayButtonState(false);
    _resetPlaybackSpeedForNewSong();
    clearLoop();
    _resetSectionPracticeLog();
    _hideSectionPracticeBar();
    // Reset so the jump-fix (setInterval, ~line 8979) doesn't mistake the new
    // song starting at t=0 for an unexpected seek from the previous song's
    // position. audio.currentTime may not reset synchronously when src is cleared.
    lastAudioTime = 0;

    currentFilename = filename;
    // A fresh load arms autoplay; a pending auto-exit from the previous
    // song is no longer relevant. A *resume* load (options.resume) instead
    // arms _pendingResume — consumed at song:ready to restore speed + seek to
    // the saved position, then start — so autostart and resume don't both try
    // to begin playback from different positions.
    if (options && options.resume && Number(options.resume.position) > 0) {
        _pendingResume = options.resume;
        _pendingAutostart = false;
    } else {
        _pendingResume = null;
        _pendingAutostart = true;
    }
    _clearAutoExit();
    // Remember which screen the player was launched from so Esc /
    // navigation back from the player (and auto-exit) returns the user
    // there (feedBack#126).
    _playerOriginScreen = _resolvePlayerOrigin();
    showScreen('player');

    // Wait for previous WebSocket to fully close before opening new one
    await new Promise(r => setTimeout(r, 500));
    highway.init(document.getElementById('highway'));

    const wsParams = new URLSearchParams();
    if (arrangement !== undefined) wsParams.set('arrangement', arrangement);
    wsParams.set('naming_mode', _getArrangementNamingMode());
    const wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/highway/${decodeURIComponent(filename)}?${wsParams.toString()}`;
    highway.connect(wsUrl);
    _resetSectionPracticeLog();
    _scheduleSectionPracticeRetries();
    loadSavedLoops();
    document.getElementById('quality-select').value = highway.getRenderScale();
    const _minScaleSel = document.getElementById('min-scale-select');
    if (_minScaleSel && highway.getMinRenderScale) _minScaleSel.value = String(highway.getMinRenderScale());
}

// Generation token + safety-timeout handle for changeArrangement's
// aria-busy gate. Module-scoped so a newer invocation cancels the
// previous one's pending timeout (and its _onReady callback bails when
// the gen has moved on) rather than clearing aria-busy for itself.
let _arrBusyGen = 0;
let _arrBusyTimeout = null;

async function changeArrangement(index) {
    if (currentFilename) {
        // Tear down any pending fresh-load credits before switching: the
        // no-count-in hold timer would otherwise fire togglePlay() against the
        // incoming (still-loading) arrangement. hideSongCreditsOverlay() clears
        // the timer, the song:play listener, and the overlay node.
        hideSongCreditsOverlay();
        window.feedBack.emit('song:arrangement-changed', { filename: currentFilename, arrangement: index });
        const wasPlaying = isPlaying;
        const time = _audioTime();
        if (isPlaying) {
            if (window._juceMode) await jucePlayer.pause();
            else audio.pause();
            isPlaying = false;
        }

        // Audio is paused, but the play button is intentionally left
        // showing its pre-load state to avoid flicker if auto-resume
        // succeeds. Tell assistive tech to wait until the load +
        // seek-restore + auto-resume settles before re-announcing the
        // button so screen readers don't briefly advertise stale state.
        // Pair with a safety timeout so a websocket/server failure that
        // never reaches `ready` can't leave the button perpetually busy.
        const myGen = ++_arrBusyGen;
        const playBtn = document.getElementById('btn-play');
        if (playBtn) playBtn.setAttribute('aria-busy', 'true');
        if (_arrBusyTimeout !== null) clearTimeout(_arrBusyTimeout);
        _arrBusyTimeout = setTimeout(() => {
            if (myGen !== _arrBusyGen) return;
            _arrBusyTimeout = null;
            const b = document.getElementById('btn-play');
            if (b) b.removeAttribute('aria-busy');
        }, 30000);

        // Show loading overlay
        let overlay = document.getElementById('arr-loading');
        if (overlay) overlay.remove();
        overlay = document.createElement('div');
        overlay.id = 'arr-loading';
        overlay.className = 'fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm';
        overlay.innerHTML = `
            <div class="bg-dark-700 border border-gray-700 rounded-2xl p-6 w-72 text-center shadow-2xl">
                <div class="text-sm text-gray-300 mb-3">Loading arrangement...</div>
                <div class="progress-bar"><div class="fill" style="width:30%;animation:pulse 1s infinite"></div></div>
            </div>`;
        document.body.appendChild(overlay);

        // Set callback for when data is ready. Capture the function ref
        // so a stale older invocation firing after a newer changeArrangement
        // has installed its own callback can't clobber the newer one.
        const myCallback = async () => {
            // Bail in full if this invocation has been superseded. The newer
            // changeArrangement owns the overlay (same id), its own _onReady,
            // and the aria-busy gate; this old callback must not touch any
            // of them.
            if (myGen !== _arrBusyGen) return;
            const ol = document.getElementById('arr-loading');
            if (ol) ol.remove();
            const clearBusy = () => {
                // Double-checked because a newer invocation could land
                // during the await below.
                if (myGen !== _arrBusyGen) return;
                if (_arrBusyTimeout !== null) {
                    clearTimeout(_arrBusyTimeout);
                    _arrBusyTimeout = null;
                }
                const b = document.getElementById('btn-play');
                if (b) b.removeAttribute('aria-busy');
            };
            const clearMyCallback = () => {
                // Only null out if the slot still points at us; a newer
                // invocation may have replaced it during the await.
                if (highway._onReady === myCallback) highway._onReady = null;
            };
            const r = await _audioSeek(time, 'arrangement-restore');
            // Don't auto-resume on cancel OR off-target landing — same
            // 50 ms tolerance as loop-wrap / loop-set. Resuming play from
            // a different position than the user's previous play position
            // would be jarring; better to leave them at the post-seek
            // (likely close-but-not-equal) position without auto-play.
            if (!r.completed || Math.abs(r.to - time) > 0.05) {
                // changeArrangement paused audio at entry (line 3032) but
                // didn't update the button or emit song:pause — those were
                // meant to be no-ops if the auto-resume succeeded. On
                // abort, sync the transport: button -> 'Play',
                // sm.isPlaying = false, emit song:pause so plugins see the
                // paused state.
                if (wasPlaying) {
                    setPlayButtonState(false);
                    if (window.feedBack) {
                        window.feedBack.isPlaying = false;
                        window.feedBack.emit('song:pause', _songEventPayload());
                    }
                }
                clearBusy();
                clearMyCallback();
                return;
            }
            if (wasPlaying) {
                if (window._juceMode) {
                    const started = await jucePlayer.play();
                    if (started) {
                        isPlaying = true;
                        window.feedBack.isPlaying = true;
                        const payload = _songEventPayload();
                        window.feedBack.emit('song:play', payload);
                        window.feedBack.emit('song:resume', payload);
                    }
                } else audio.play().then(() => { isPlaying = true; }).catch(() => {});
            }
            clearBusy();
            clearMyCallback();
        };
        highway._onReady = myCallback;

        // Reset the Section Practice bar for the incoming arrangement, mirroring
        // playSong(): different arrangements have different section markers, so
        // the old chips/labels and active-parent index must not carry over.
        // _hideSectionPracticeBar() clears the chips (bar becomes "not ready"),
        // so the draw hook re-renders fresh once the new arrangement's sections
        // arrive — even when the new arrangement happens to have the same parent
        // count. The A-B loop itself is left intact (time-based, song-global).
        _hideSectionPracticeBar();
        _resetSectionPracticeLog();
        _sectionPracticeLastParentCount = -1;

        highway.reconnect(currentFilename, index);
        window.feedBack.emit('arrangement:changed', { index, filename: currentFilename });
    }
}

// Per-attempt counter for HTML5 audio.play() invocations. Bumped on
// every play branch entry so a slow rejection from attempt N can't
// clobber the UI of a newer attempt N+1 within the same session.
let _playAttemptGen = 0;

async function togglePlay() {
    if (window._juceMode) {
        if (isPlaying) {
            await jucePlayer.pause();
            isPlaying = false;
            setPlayButtonState(false);
            window.feedBack.isPlaying = false;
            window.feedBack.emit('song:pause', _songEventPayload());
        } else {
            const started = await jucePlayer.play();
            if (!started) return; // startBacking() failed — IPC error already logged
            isPlaying = true;
            setPlayButtonState(true);
            window.feedBack.isPlaying = true;
            const payload = _songEventPayload();
            window.feedBack.emit('song:play', payload);
            window.feedBack.emit('song:resume', payload);
        }
        return;
    }
    if (isPlaying) {
        audio.pause(); isPlaying = false;
        setPlayButtonState(false);
    } else {
        // Flip the UI optimistically before awaiting the play() Promise so
        // a quick second click during a slow start (buffering, device
        // wake, etc.) still enters the pause branch above. Two stale-
        // resolution guards:
        //   - _audioSeekGen: bumped in showScreen() teardown and
        //     playSong(), so a rejection from a torn-down session can't
        //     touch new-session UI. Survives same-URL reloads.
        //   - _playAttemptGen: bumped on every play branch entry, so
        //     within a single session a slow rejection from attempt N
        //     can't clobber a faster attempt N+1 (Play → Pause → Play).
        const sessionGen = _audioSeekGen;
        const attempt = ++_playAttemptGen;
        isPlaying = true;
        setPlayButtonState(true);
        try {
            await audio.play();
        } catch (err) {
            if (sessionGen !== _audioSeekGen) return;
            if (attempt !== _playAttemptGen) return;
            // An engine reroute (HTML5 -> JUCE) deliberately pauses the <audio>
            // element mid-migration, which rejects this in-flight play() with an
            // AbortError even though playback continues on the JUCE transport.
            // The reroute owns isPlaying / the button while it runs (same guard
            // the <audio> 'play'/'pause' listeners use); resetting here would
            // leave the button showing Play while the song keeps playing — the
            // "two clicks to pause on the first song after a fresh load" bug.
            if (window._juceRerouteInProgress) return;
            console.error('[app] audio.play() rejected:', err);
            isPlaying = false;
            setPlayButtonState(false);
        }
    }
}

async function seekBy(s) {
    await _audioSeek(Math.max(0, _audioTime() + s), 'seek-by');
}

// Restart the current song from the beginning (or from loop A when an A–B
// loop is armed). Uses the canonical _audioSeek funnel only — never touches
// audio.currentTime directly and never reloads via playSong().
async function restartCurrentSong() {
    _cancelCountIn();
    let loopA = null;
    let loopB = null;
    if (window.feedBack && typeof window.feedBack.getLoop === 'function') {
        try {
            const loop = window.feedBack.getLoop();
            if (loop && typeof loop === 'object') {
                loopA = loop.loopA;
                loopB = loop.loopB;
            }
        } catch (_) { /* host misbehaviour — treat as no loop */ }
    }
    const hasLoop = loopA != null && loopB != null;
    const target = hasLoop ? loopA : 0;
    const r = await _audioSeek(target, 'song-restart');
    if (!r.completed) return false;
    if (hasLoop) {
        // Verify the seek actually landed at loop A (JUCE may clamp / HTML5 may
        // snap) before the count-in fixes the visuals there — otherwise the
        // count-in would start from loopA while the audio backend sits
        // elsewhere. ~50 ms tolerance, matching the loop paths.
        if (Number.isFinite(r.to) && Math.abs(r.to - target) > 0.05) {
            console.warn('[restart] seek landed at', r.to, 'but loop A is', target, '— skipping count-in');
            return false;
        }
        await startCountIn({ immediate: true });
        return true;
    }
    if (!isPlaying) await togglePlay();
    return true;
}
window.restartCurrentSong = restartCurrentSong;
if (window.feedBack) window.feedBack.restartCurrentSong = restartCurrentSong;

// Leave the player and return to the screen the song was launched from
// (Esc shortcut uses the same origin-aware target). showScreen() owns the
// full teardown: song:stop, audio unload, highway.stop(), count-in cancel.
function closeCurrentSong() {
    // A real close (user Escape/✕, or the queue-aware wrapper once the queue is
    // exhausted) abandons any play-queue so a stale one can't advance later.
    if (window.feedBack && window.feedBack.playQueue) window.feedBack.playQueue.clear();
    return showScreen(_playerOriginScreen || 'home');
}
window.closeCurrentSong = closeCurrentSong;
if (window.feedBack) window.feedBack.closeCurrentSong = closeCurrentSong;

// ── Play-queue: sequential playback of a playlist / album ──────────────────
// Playing a list should advance to the next track when a song ends, instead of
// returning to the menu (the long-standing "plays one song then boots to menu"
// gap — a queue was simply never implemented). Advancing rides the SAME exit
// choke point as auto-exit and a results-card close: window.closeCurrentSong().
// Song-end paths call window.closeCurrentSong() (the auto-exit grace timer, and
// a results screen's release()), so wrapping it lets the queue advance on song
// end AND after the user dismisses a score card. A *user* exit (Escape / the ✕)
// calls the bareword closeCurrentSong(), which we deliberately leave alone, so
// leaving the player still leaves — and abandons the queue.
window.feedBack.playQueue = (function () {
    let list = [], idx = -1, source = '', arrangements = null;
    const active = () => idx >= 0 && idx < list.length;
    const hasNext = () => active() && idx < list.length - 1;
    function clear() { list = []; idx = -1; source = ''; arrangements = null; }
    function _play(i) {
        const fn = list[i];
        // fromQueue keeps the queue from clearing itself; playSong decodeURIs.
        window.playSong(encodeURIComponent(fn), arrangements ? arrangements[i] : undefined, { fromQueue: true });
    }
    function start(files, opts) {
        files = (files || []).filter(Boolean);
        if (!files.length) return false;
        list = files.slice(); idx = 0;
        source = (opts && opts.source) || '';
        arrangements = (opts && opts.arrangements) ? opts.arrangements.slice() : null;
        if (opts && opts.shuffle && list.length > 1) {
            // Fisher-Yates, once at start. Swap arrangements in lockstep so an
            // album slot's pinned arrangement stays glued to its file (#685).
            for (let i = list.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [list[i], list[j]] = [list[j], list[i]];
                if (arrangements) [arrangements[i], arrangements[j]] = [arrangements[j], arrangements[i]];
            }
        }
        if (window.fbNotify) {
            try { window.fbNotify.show({ title: 'Playing ' + (source || 'queue'), message: files.length + ' songs', icon: '▶' }); } catch (e) { /* */ }
        }
        _play(idx);
        return true;
    }
    function advance() {
        if (!hasNext()) { clear(); return false; }
        idx++;
        _play(idx);
        return true;
    }
    return {
        start: start, advance: advance, hasNext: hasNext, active: active, clear: clear,
        source: function () { return source; },
        remaining: function () { return active() ? list.length - idx - 1 : 0; },
        // What's coming, for consumers that RENDER the queue (a results
        // screen's "Up next: … starting in 10s" strip) without reaching into
        // queue internals. Null when nothing follows.
        peekNext: function () {
            return hasNext()
                ? { filename: list[idx + 1], index: idx + 1, total: list.length }
                : null;
        },
    };
})();

// Make the song-end exit queue-aware (see above). Wrap window.closeCurrentSong
// (and feedBack.closeCurrentSong) so that when a queue has a next track, we play
// it instead of returning to the menu. The bareword closeCurrentSong() used by a
// user-initiated exit is unaffected.
(function () {
    const realClose = window.closeCurrentSong;
    function queueAwareClose() {
        const q = window.feedBack.playQueue;
        if (q && q.hasNext()) { q.advance(); return; }
        if (q) q.clear();
        return realClose.apply(this, arguments);
    }
    window.closeCurrentSong = queueAwareClose;
    if (window.feedBack) window.feedBack.closeCurrentSong = queueAwareClose;
})();

// ── "Ask before leaving a song" (Gameplay tab, default OFF) ────────────────
// Client-only localStorage pref (`confirmExitSong`); absence = OFF. When ON, a
// *user-initiated* exit (Escape, or the player ✕) opens a small confirm instead
// of leaving immediately. Auto-exit on song-end and a results screen's own
// Close never prompt — they call closeCurrentSong() directly, which stays the
// unguarded actual-exit.
function _exitConfirmEnabled() {
    try { return localStorage.getItem('confirmExitSong') === '1'; } catch (_) { return false; }
}
// Settings checkbox setter (onchange="setConfirmExitSong(this.checked)").
window.setConfirmExitSong = function (on) {
    try { localStorage.setItem('confirmExitSong', on ? '1' : '0'); } catch (_) { /* private mode */ }
    const el = document.getElementById('setting-confirm-exit');
    if (el && el.checked !== !!on) el.checked = !!on;
};

let _exitConfirmOpen = false;   // guard against stacking confirm modals

// User-initiated request to leave the player. Honors the confirm toggle; the
// actual exit is always closeCurrentSong() (origin-aware teardown).
function requestExitSong() {
    if (!_exitConfirmEnabled()) { closeCurrentSong(); return; }
    if (_exitConfirmOpen) return;   // already asking
    _openExitConfirm();
}
window.requestExitSong = requestExitSong;
if (window.feedBack) window.feedBack.requestExitSong = requestExitSong;

// A *true* modal (role="dialog" aria-modal="true" + .feedBack-modal) so the
// Escape/Space carve-outs classify it as a focus trap — they won't fire
// player-back / play-pause while it's up. Opening it PAUSES the song so it
// isn't running (or being scored) behind the prompt; Stay resumes exactly what
// we paused. Escape matches every other modal (and the generic _confirmDialog):
// it *dismisses* the prompt → Stay → drops you back into the (resumed) song —
// so a second Escape does NOT leave. Leaving is the explicit, default-focused
// "Leave" button, so Space/Enter (or click) is the keyboard "just get me out".
function _openExitConfirm() {
    _exitConfirmOpen = true;
    // Freeze the song while the user decides: cancel any pending count-in (so it
    // can't start playback behind the modal) and pause if we're playing. Stay
    // resumes only what we paused (wasPlaying), and only if the same song is
    // still live on the player — guarding a teardown/seek/end behind the prompt.
    _cancelCountIn();
    const _resumeGen = _audioSeekGen;
    const _wasPlaying = isPlaying;
    if (_wasPlaying) Promise.resolve(togglePlay()).catch(() => {});
    const overlay = document.createElement('div');
    overlay.id = 'fb-exit-confirm';
    overlay.className = 'feedBack-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Leave this song?');
    overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:200', 'display:flex',
        'align-items:center', 'justify-content:center',
        'background:rgba(0,0,0,0.6)',
        'font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
    ].join(';');

    const card = document.createElement('div');
    card.style.cssText = [
        'max-width:min(92vw,360px)', 'padding:18px 18px 14px',
        'background:#111827', 'color:#e5e7eb',
        'border:1px solid rgba(148,163,184,0.25)', 'border-radius:12px',
        'box-shadow:0 12px 40px rgba(0,0,0,0.5)', 'text-align:left',
    ].join(';');
    const h = document.createElement('div');
    h.textContent = 'Leave this song?';
    h.style.cssText = 'font-size:16px;font-weight:700;color:#fff;margin-bottom:6px';
    const p = document.createElement('div');
    p.textContent = 'You can pick up where you left off from the Resume pill.';
    p.style.cssText = 'opacity:0.75;margin-bottom:16px';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
    const stayBtn = document.createElement('button');
    stayBtn.type = 'button';
    stayBtn.textContent = 'Stay';
    stayBtn.style.cssText = 'padding:8px 14px;border:1px solid rgba(148,163,184,0.3);border-radius:8px;background:transparent;color:#e5e7eb;cursor:pointer';
    const leaveBtn = document.createElement('button');
    leaveBtn.type = 'button';
    leaveBtn.textContent = 'Leave';
    leaveBtn.style.cssText = 'padding:8px 14px;border:0;border-radius:8px;background:#4080e0;color:#fff;font-weight:600;cursor:pointer';

    let settled = false;
    function close(leave) {
        if (settled) return;
        settled = true;
        _exitConfirmOpen = false;
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        if (leave) { closeCurrentSong(); return; }
        // Stay → resume exactly what we paused, but only if the session is still
        // the same live song on the player (not torn down / ended / seeked away
        // behind the modal). If the user was already paused, leave them paused.
        if (_wasPlaying && !isPlaying &&
            _audioSeekGen === _resumeGen &&
            document.querySelector('.screen.active')?.id === 'player') {
            Promise.resolve(togglePlay()).catch(() => {});
        }
    }
    // Capture-phase so this dialog owns Escape and it can't fall through to the
    // player-scope back shortcut. Escape = Stay (dismiss the prompt and resume
    // the song) — consistent with every other modal, so a second Escape does
    // NOT leave. Space/Enter stay on native activation of the focused button
    // (Leave by default), so the keyboard "leave" is Space/Enter.
    function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(false); }
    }
    document.addEventListener('keydown', onKey, true);
    leaveBtn.addEventListener('click', () => close(true));
    stayBtn.addEventListener('click', () => close(false));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(false); });

    row.appendChild(stayBtn);
    row.appendChild(leaveBtn);
    card.appendChild(h);
    card.appendChild(p);
    card.appendChild(row);
    overlay.appendChild(card);
    (document.body || document.documentElement).appendChild(overlay);
    // Trap Tab within the dialog (Stay ↔ Leave) so focus can't fall back to the
    // player controls underneath while it's open.
    _trapFocusInModal(overlay);
    // Default focus on "Leave" so Space/Enter leaves immediately.
    leaveBtn.focus();
}
window._openExitConfirm = _openExitConfirm;   // exposed for tests/debugging

const SPEED_PRESET_PCTS = [100, 90, 80, 75, 70, 60, 50];
const SPEED_SNAP_THRESHOLD = 0.02;
let _speedPresetsWired = false;

function _speedPresetPctFromActive(activePctOrRate) {
    if (!Number.isFinite(activePctOrRate)) return null;
    const rate = activePctOrRate <= 1.5 ? activePctOrRate : activePctOrRate / 100;
    for (const pct of SPEED_PRESET_PCTS) {
        if (Math.abs(rate - pct / 100) <= SPEED_SNAP_THRESHOLD) return pct;
    }
    return null;
}

function _updateSpeedPresetButtons(activePctOrRate) {
    const wrap = document.getElementById('speed-presets');
    if (!wrap) return;
    const target = _speedPresetPctFromActive(activePctOrRate);
    for (const btn of wrap.querySelectorAll('[data-speed-preset]')) {
        const pct = Number(btn.dataset.speedPreset);
        btn.classList.toggle('v3-speed-preset-active', target !== null && pct === target);
    }
}

function applySpeedPreset(percent) {
    const slider = document.getElementById('speed-slider');
    if (!slider) return;
    const pct = Math.max(
        Number(slider.min) || 15,
        Math.min(Number(slider.max) || 150, Number(percent)),
    );
    if (!Number.isFinite(pct)) return;
    slider.value = String(pct);
    handleSliderInput(slider);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
}
window.applySpeedPreset = applySpeedPreset;

function _wireSpeedPresetsOnce() {
    if (_speedPresetsWired) return;
    const presets = document.getElementById('speed-presets');
    if (!presets) return;
    _speedPresetsWired = true;
    presets.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-speed-preset]');
        if (!btn) return;
        applySpeedPreset(Number(btn.dataset.speedPreset));
    });
}

function setSpeed(v) {
    const speedSlider = document.getElementById('speed-slider');
    const rate = Number(v);
    if (!Number.isFinite(rate)) {
        return;
    }
    if (window._juceMode) {
        window.jucePlayer?.setRate(rate);
        const juceAudio = window.feedBackDesktop?.audio;
        Promise.resolve()
            .then(() => juceAudio?.setBackingSpeed(rate))
            // Match the HTML5 path: preserve pitch on the JUCE backing track too.
            // Optional-chained call is a no-op on desktop builds that predate
            // setBackingPreservePitch, so this is safe to ship unconditionally.
            .then(() => juceAudio?.setBackingPreservePitch?.(true))
            .catch(err => console.warn('[setSpeed] backing speed/preserve-pitch failed:', err));
    } else {
        audio.playbackRate = rate;
    }
    const speedLabel = document.getElementById('speed-label');
    if (speedLabel) speedLabel.textContent = rate.toFixed(2) + 'x';
    handleSliderInput(speedSlider);
    _updateSpeedPresetButtons(rate);
}

function _resetPlaybackSpeedForNewSong() {
    // Reset the *actual* playback rate to 1x, not just the visible slider/label
    // (feedBack#615). The HTML5 <audio> element and the desktop JUCE/backing
    // engine each retain their own rate, and which one drives the next song
    // isn't decided until later in the load, so reset all paths unconditionally.
    // Every setter is idempotent and optional-chained, so this is safe in web
    // and desktop builds alike — no need to branch on window._juceMode.
    const speedSlider = document.getElementById('speed-slider');
    if (speedSlider) speedSlider.value = 100;
    audio.playbackRate = 1;
    window.jucePlayer?.setRate?.(1);
    const juceAudio = window.feedBackDesktop?.audio;
    Promise.resolve()
        .then(() => juceAudio?.setBackingSpeed?.(1))
        .then(() => juceAudio?.setBackingPreservePitch?.(true))
        .catch(err => console.warn('[resetSpeed] backing speed/preserve-pitch failed:', err));
    // Mirror setSpeed's UI side-effects (label text + slider fill styling).
    const speedLabel = document.getElementById('speed-label');
    if (speedLabel) speedLabel.textContent = (1).toFixed(2) + 'x';
    handleSliderInput(speedSlider);
    _updateSpeedPresetButtons(100);
}
// Master-difficulty slider (feedBack#48). Persists partial via
// /api/settings — the POST handler merges only the keys present, so
// this fire-and-forget call doesn't clobber dlc_dir or other settings.
//
// Debounced trailing-edge (300ms) so dragging the slider — which fires
// oninput per pixel — doesn't flood the server with concurrent writes
// to config.json. highway.setMastery() still fires every oninput so
// the chart re-filters in real time; only disk persistence waits.
let _masteryPersistTimer = null;
function _persistMastery(pct) {
    if (_masteryPersistTimer) clearTimeout(_masteryPersistTimer);
    _masteryPersistTimer = setTimeout(() => {
        _masteryPersistTimer = null;
        fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ master_difficulty: pct }),
        }).catch(() => { /* best-effort — next setMastery() will retry */ });
    }, 300);
}
function setMastery(v) {
    _applyMastery(v);
}
// Shared mastery applier. Master difficulty has two controls that write the
// same master_difficulty key: the player-popover slider (#mastery-slider) and
// the Gameplay-tab "Note highway speed" slider (#setting-highway-speed). Route
// both — and loadSettings' hydration — through here so their positions,
// labels, and track fills stay in sync regardless of which the user touches,
// plus the live highway re-filter and the debounced persist. All element reads
// are null-guarded since either control may be absent (follower window, or the
// settings markup not yet rendered).
function _applyMastery(v, opts = {}) {
    // Guard + clamp: v might be a slider string, a programmatic call from a
    // plugin, or a restored settings value with a bad shape. Don't let NaN
    // reach a label (would show "NaN%") or the POST.
    const parsed = parseInt(v, 10);
    if (!Number.isFinite(parsed)) return;
    const pct = Math.max(0, Math.min(100, parsed));
    const popLabel = document.getElementById('mastery-label');
    if (popLabel) popLabel.textContent = pct + '%';
    const popSlider = document.getElementById('mastery-slider');
    if (popSlider) {
        if (String(popSlider.value) !== String(pct)) popSlider.value = pct;
        handleSliderInput(popSlider);
    }
    const setSlider = document.getElementById('setting-highway-speed');
    if (setSlider) {
        if (String(setSlider.value) !== String(pct)) setSlider.value = pct;
        handleSliderInput(setSlider);
    }
    // The Gameplay-tab label markup appends a literal "%" after this span
    // (matching the av-offset "ms" pattern), so write the number alone here —
    // unlike #mastery-label above, whose markup carries no trailing unit.
    const setLabel = document.getElementById('setting-highway-speed-val');
    if (setLabel) setLabel.textContent = pct;
    highway.setMastery(pct / 100);
    if (!opts.skipPersist) _persistMastery(pct);
}
// Reflect phrase-data availability on the slider after every `ready`.
// The server omits the `phrases` message entirely for single-level
// sources (GP imports, legacy sloppak), so hasPhraseData() is the
// right signal to enable/disable the slider.
function _applyMasteryAvailability(hasPhraseData) {
    const slider = document.getElementById('mastery-slider');
    if (!slider) return;
    if (hasPhraseData) {
        slider.disabled = false;
        slider.title = 'Master difficulty — low = simpler chart, high = full';
    } else {
        slider.disabled = true;
        slider.title = 'Source chart has a single difficulty level — slider disabled';
    }
}
if (window.feedBack) {
    window.feedBack.on('song:loaded', syncDefaultArrangementPin);
    window.feedBack.on('arrangement:changed', syncDefaultArrangementPin);
    // feedBack's event bus dispatches CustomEvent with the payload in
    // event.detail (see EventTarget setup around line 699), so the
    // handler receives an Event, not the raw payload.
    window.feedBack.on('song:ready', (e) => {
        _applyMasteryAvailability(!!e.detail?.hasPhraseData);
        // Auto mode: re-evaluate the active renderer against the
        // newly-loaded song. The picker's current <option> value is the
        // source of truth here — localStorage is a persistence mirror
        // that can throw in private / sandboxed contexts, and the
        // picker already reflects fresh-install / post-cleanup
        // fallthroughs to 'auto' even when writes failed.
        const sel = document.getElementById('viz-picker');
        if (sel && sel.value === 'auto') {
            _autoMatchViz();
        } else if (sel) {
            // Explicit selection: the renderer persists across songs, so a
            // notation-only arrangement landing on a non-notation viz (e.g.
            // the fresh-install highway_3d default) would render an empty
            // board with no explanation. Surface the install hint.
            _maybeShowNotationViewHint(sel.value);
        }
    });
    // Highway signals when it's auto-reverted to the default renderer
    // after a broken plugin (init failure or repeated draw failures).
    // Sync the picker + persisted selection so the UI stops advertising
    // the broken choice and the user doesn't hit the same failure on
    // next reload.
    window.feedBack.on('viz:reverted', (e) => {
        const sel = document.getElementById('viz-picker');
        if (sel) sel.value = 'default';
        // Cancel any pending viz:renderer:ready label listener — the renderer
        // that was queued never became (or stayed) active.
        if (_cancelPendingAutoLabel) { _cancelPendingAutoLabel(); _cancelPendingAutoLabel = null; }
        // Clear any Auto-resolved label — the renderer that was advertised
        // never became (or stayed) active.
        _setAutoVizLabel(null);
        try { localStorage.setItem('vizSelection', 'default'); } catch (_) {}
        console.warn(
            `viz picker: reverted to default renderer (${e.detail?.reason || 'unknown'}).`
        );
    });
}

// ── Visualization picker (feedBack#36) ─────────────────────────────────
//
// Discovers viz plugins via /api/plugins and adds them to the #viz-picker
// dropdown. A viz plugin declares itself by setting `"type": "visualization"`
// in its plugin.json AND exposing a factory function on
// window.feedBackViz_<id> that returns an object matching the setRenderer
// contract ({init, draw, resize, destroy}).
//
// The "default" option in the dropdown is the built-in 2D highway that
// lives inside createHighway(); selecting it calls setRenderer(null) which
// restores the default renderer. The bundled 3D Highway plugin
// (plugins/highway_3d/) registers as id `highway_3d` and is the new
// fresh-install default per feedBack#160 PR 3.

// ── WebGL2 detection (one-shot probe) ────────────────────────────────────
// 3D Highway requires WebGL2. On environments where it's unavailable
// (older browsers, some embedded webviews, software-only contexts), we
// silently fall back to the Classic 2D Highway and flash a single toast
// so the user knows why their highway looks different. Cached so we don't
// thrash the GPU with repeat throwaway-canvas creations.
let _webgl2Probe = null;
function _canRun3D() {
    if (_webgl2Probe !== null) return _webgl2Probe;
    try {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl2');
        _webgl2Probe = !!gl;
        // Lose the context immediately — the probe canvas is never reused.
        if (gl && gl.getExtension) {
            const ext = gl.getExtension('WEBGL_lose_context');
            if (ext && ext.loseContext) ext.loseContext();
        }
    } catch (_) { _webgl2Probe = false; }
    return _webgl2Probe;
}

// ── Migration / nag flags ────────────────────────────────────────────────
// `feedBack_3d_promoted_v1` is set the first time we auto-flip an existing
// `vizSelection='default'` user to `'highway_3d'`. Persistence ensures we
// don't re-nag on every reload — and ensures the WebGL2 fallback path
// doesn't ping-pong (one fallback toast, not one per page load).
const _3D_PROMOTED_FLAG_KEY = 'feedBack_3d_promoted_v1';
function _markPromoted() {
    try { localStorage.setItem(_3D_PROMOTED_FLAG_KEY, '1'); } catch (_) {}
}
function _hasPromotedFlag() {
    try { return localStorage.getItem(_3D_PROMOTED_FLAG_KEY) === '1'; }
    catch (_) { return false; }
}

// Pending nag: queued during _populateVizPicker, fired on the first
// `song:ready` (so the toast lands when the user actually opens the
// player, not at page load when they're still in the library).
// `song:ready` is emitted by highway.js via window.feedBack.emit(), so
// subscribe through the same EventTarget. window.feedBack is created in
// this same file before _populateVizPicker is reachable, so the global
// is guaranteed to exist by the time this listener registers — but guard
// anyway in case this module is ever loaded standalone for tests.
let _pendingPromotionNag = false;
if (window.feedBack && typeof window.feedBack.on === 'function') {
    window.feedBack.on('song:ready', () => {
        if (!_pendingPromotionNag) return;
        _pendingPromotionNag = false;
        _showPromotionNag();
    });
}

function _showPromotionNag() {
    // Lightweight toast — no dependency on a generic toast helper, since
    // app.js doesn't currently have one. Fixed bottom-center, dismissed
    // by clicking either action button or the × close.
    const existing = document.getElementById('feedBack-3d-nag');
    if (existing) existing.remove();
    const wrap = document.createElement('div');
    wrap.id = 'feedBack-3d-nag';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'false');
    wrap.setAttribute('aria-label', '3D Highway upgrade notification');
    wrap.style.cssText = `
        position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
        background: linear-gradient(145deg, #1a1a30 0%, #0d0d18 100%);
        border: 1px solid rgba(64,128,224,0.4);
        border-radius: 12px; padding: 12px 16px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(64,128,224,0.15);
        font-size: 13px; color: #e2e8f0; z-index: 10000;
        max-width: 480px; display: flex; align-items: center; gap: 12px;
    `;
    wrap.innerHTML = `
        <span aria-live="polite" style="flex:1;">Your highway was upgraded to <strong>3D</strong>.</span>
        <button type="button" data-act="tour" style="background:rgba(64,128,224,0.25);color:#e2e8f0;border:1px solid rgba(64,128,224,0.5);padding:6px 12px;border-radius:8px;font-size:12px;cursor:pointer;">Try the tour</button>
        <button type="button" data-act="back" style="background:transparent;color:#cbd5e1;border:1px solid rgba(255,255,255,0.1);padding:6px 12px;border-radius:8px;font-size:12px;cursor:pointer;">Switch back to 2D</button>
        <button type="button" data-act="dismiss" aria-label="Dismiss" style="background:transparent;color:#6b7280;border:none;font-size:18px;cursor:pointer;padding:0 4px;line-height:1;">×</button>
    `;
    wrap.addEventListener('click', (ev) => {
        const btn = ev.target.closest('button[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'tour') {
            try {
                if (window.feedBackTour && typeof window.feedBackTour.start === 'function') {
                    window.feedBackTour.start('highway_3d');
                }
            } catch (_) {}
        } else if (act === 'back') {
            setViz('default');
        }
        wrap.remove();
    });
    document.body.appendChild(wrap);
}

function _showWebGL2FallbackToast() {
    // One-time fallback notice. Same lightweight DOM as the nag, simpler
    // copy and only a dismiss button.
    if (document.getElementById('feedBack-3d-fallback')) return;
    const wrap = document.createElement('div');
    wrap.id = 'feedBack-3d-fallback';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'false');
    wrap.setAttribute('aria-label', 'WebGL2 not available');
    wrap.style.cssText = `
        position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
        background: #181830; border: 1px solid rgba(255,180,80,0.4);
        border-radius: 12px; padding: 10px 14px;
        font-size: 12px; color: #e2e8f0; z-index: 10000;
        display: flex; align-items: center; gap: 10px;
    `;
    wrap.innerHTML = `
        <span aria-live="polite">3D Highway needs WebGL2 — falling back to Classic 2D.</span>
        <button type="button" data-act="dismiss" aria-label="Dismiss" style="background:transparent;color:#6b7280;border:none;font-size:16px;cursor:pointer;padding:0 4px;line-height:1;">×</button>
    `;
    wrap.addEventListener('click', (ev) => {
        if (ev.target.closest('button[data-act]')) wrap.remove();
    });
    document.body.appendChild(wrap);
    setTimeout(() => { try { wrap.remove(); } catch (_) {} }, 8000);
}

// The "default" option in the dropdown is the built-in 2D highway that
// lives inside createHighway(); selecting it calls setRenderer(null) which
// restores the default renderer.
function _ensureVenueVizOption(sel) {
    if (!sel) return;
    if (Array.from(sel.options).some(opt => opt.value === 'venue')) return;
    if (!Array.from(sel.options).some(opt => opt.value === 'highway_3d')) return;
    const h3dOpt = Array.from(sel.options).find(opt => opt.value === 'highway_3d');
    const opt = document.createElement('option');
    opt.value = 'venue';
    opt.textContent = 'Venue';
    if (h3dOpt && h3dOpt.nextSibling) sel.insertBefore(opt, h3dOpt.nextSibling);
    else sel.appendChild(opt);
}

function _syncVenueVizPlayerClass(vizId) {
    if (window.v3VenueViz && typeof window.v3VenueViz.setSelectedVizId === 'function') {
        window.v3VenueViz.setSelectedVizId(vizId);
        return;
    }
    if (window.v3VenueViz && typeof window.v3VenueViz.syncPlayerVizClass === 'function') {
        window.v3VenueViz.syncPlayerVizClass(vizId);
        return;
    }
    const player = document.getElementById('player');
    if (player) player.classList.toggle('is-venue-visualization', vizId === 'venue');
}

async function _populateVizPicker(plugins) {
    const sel = document.getElementById('viz-picker');
    if (!sel) return;
    // Clear any previously-appended plugin options so calling this
    // function more than once (e.g. from DevTools, or a hot-reloaded
    // plugin) doesn't produce duplicates. The built-in "auto" and
    // "default" options are static markup — preserve them.
    const BUILTIN_OPT_VALUES = new Set(['auto', 'default', 'venue']);
    Array.from(sel.options).forEach(opt => {
        if (!BUILTIN_OPT_VALUES.has(opt.value)) sel.removeChild(opt);
    });
    // Accept a pre-fetched plugins array (normal startup path reuses
    // loadPlugins' fetch). Fall back to our own fetch if called
    // standalone — e.g. from the DevTools console for debugging.
    if (!Array.isArray(plugins)) {
        plugins = [];
        try {
            const resp = await fetch('/api/plugins');
            if (resp.ok) plugins = await resp.json();
        } catch (e) {
            console.warn('viz picker: /api/plugins fetch failed', e);
        }
    }
    const vizPlugins = plugins.filter(p => p && p.type === 'visualization');
    // "default" is reserved for the built-in 2D renderer option and
    // "auto" is reserved for the Auto-mode entry — both already in the
    // <select>. A plugin with either id would collide: the
    // restore-from-localStorage lookup would find the built-in entry,
    // dragging the plugin into never-selected land silently. Fail
    // loudly instead.
    const RESERVED_IDS = new Set(['default', 'auto']);
    for (const p of vizPlugins) {
        if (RESERVED_IDS.has(p.id)) {
            console.error(`viz picker: plugin id '${p.id}' collides with a reserved built-in picker entry ('auto' = Auto mode, 'default' = built-in 2D highway); rename the plugin's id in plugin.json to include it in the picker.`);
            continue;
        }
        // Skip entries where the plugin script hasn't exposed a factory —
        // likely means the script failed to load, or the plugin declared
        // itself as a viz without shipping the factory yet.
        const factoryName = 'feedBackViz_' + p.id;
        if (typeof window[factoryName] !== 'function') {
            console.warn(`viz picker: plugin '${p.id}' has type=visualization but ${factoryName} is not a function; skipping`);
            continue;
        }
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name || p.id;
        sel.appendChild(opt);
    }
    _ensureVenueVizOption(sel);
    // Refresh the visualization capability domain's provider registry from
    // the picker entries just built (the domain host introspects each
    // factory global for contextType / predicate metadata).
    if (window.feedBack.vizDomain && typeof window.feedBack.vizDomain.refreshProviders === 'function') {
        try {
            // The host reads manifest-declared per-instance settings
            // (capabilities.visualization.settings, feedBack#849) from the
            // registered capability participant by id — no need to pass them
            // through the picker here.
            window.feedBack.vizDomain.refreshProviders(
                Array.from(sel.options)
                    .filter(opt => !BUILTIN_OPT_VALUES.has(opt.value))
                    .map(opt => ({ id: opt.value, label: opt.text }))
            );
        } catch (e) { console.warn('viz picker: capability provider refresh failed', e); }
    }
    // Restore previous selection if still available. Direct option
    // scan instead of a CSS-selector lookup so we don't depend on
    // CSS.escape (missing in some test environments / older runtimes)
    // and so a weird saved string (e.g. with a quote) can't throw.
    // localStorage.getItem can itself throw when storage is blocked
    // (private mode, sandboxed iframes, some strict test runners);
    // fall back to null so the startup chain doesn't abort.
    let saved = null;
    try { saved = localStorage.getItem('vizSelection'); }
    catch (e) { console.warn('viz picker: unable to read vizSelection', e); }

    // ── 3D promotion migration (feedBack#160 PR 3) ──────────────────────
    // Existing users with `vizSelection='default'` (the old built-in 2D
    // highway) are auto-flipped to the bundled 3D Highway exactly once,
    // and a non-modal nag toast offers them "Try the tour" / "Switch
    // back to 2D" the first time they open the player. Users on `auto`
    // are left alone (auto-pick semantics unchanged). Users on a custom
    // viz plugin are left alone. WebGL2 absence falls back via setViz.
    if (saved === 'default' && !_hasPromotedFlag()) {
        const has3D = Array.from(sel.options).some(o => o.value === 'highway_3d');
        if (has3D && _canRun3D()) {
            saved = 'highway_3d';
            try { localStorage.setItem('vizSelection', 'highway_3d'); } catch (_) {}
            _markPromoted();
            _pendingPromotionNag = true;
            // Race guard: if song:ready already fired before _populateVizPicker
            // ran (e.g. a deeplink or a fast-loading song), getSongInfo() will
            // already be non-empty and we'll never receive another song:ready
            // in this session. Show the nag immediately in that case.
            const _si = window.highway && window.highway.getSongInfo();
            if (_si && _si.title) {
                _pendingPromotionNag = false;
                _showPromotionNag();
            }
        } else if (has3D && !_canRun3D()) {
            // 3D registered but WebGL2 absent — promote in name but
            // immediately fall back so we don't ping-pong on every load.
            // Set the flag so we don't try again next reload.
            _markPromoted();
            _showWebGL2FallbackToast();
        }
        // No `highway_3d` option (plugin unloaded?) → leave saved as
        // 'default'. We'll retry the migration once the plugin is back.
    }

    const savedMatches = saved && Array.from(sel.options).some(opt => opt.value === saved);
    if (savedMatches) {
        sel.value = saved;
        // 'default' needs no setViz — the highway already starts with
        // the built-in renderer. 'auto' runs setViz so _autoMatchViz
        // fires, though it's a no-op before the first song_info frame.
        if (saved !== 'default') setViz(saved);
    } else if (saved) {
        // Saved selection references an option that no longer exists —
        // plugin uninstalled since last session, renamed, or the plugin
        // script failed to register its factory this time. Clear the
        // stale value so we don't keep trying the same missing viz on
        // every reload, and fall through to the fresh-install default
        // below.
        try { localStorage.removeItem('vizSelection'); }
        catch (_) { /* storage blocked; ignore */ }
        saved = null;
    }
    if (!saved) {
        // Fresh install (or post-cleanup fallthrough): default to the
        // bundled 3D Highway when available + WebGL2-capable, falling
        // back to Auto otherwise so the arrangement-matching plugins
        // (piano on Keys songs, drums on Drums songs, ...) still take
        // over for non-3D arrangements.
        const has3D = Array.from(sel.options).some(o => o.value === 'highway_3d');
        if (has3D && _canRun3D()) {
            sel.value = 'highway_3d';
            try { localStorage.setItem('vizSelection', 'highway_3d'); } catch (_) {}
            setViz('highway_3d');
        } else {
            sel.value = 'auto';
            try { localStorage.setItem('vizSelection', 'auto'); } catch (_) {}
            if (has3D && !_canRun3D()) { _markPromoted(); _showWebGL2FallbackToast(); }
        }
    }
    // Close a startup race: if playback began before loadPlugins
    // finished, song:ready already fired while the picker had no
    // plugin options — _autoMatchViz saw no candidates and left the
    // default active. Now that plugins are registered, re-evaluate
    // against whatever song is currently loaded (a no-op when no song
    // has been loaded yet, since highway.getSongInfo() returns {}).
    if (sel.value === 'auto') _autoMatchViz();
}

function _tagVizRenderer(renderer, id) {
    if (!renderer || !id) return renderer;
    try {
        if (!renderer.pluginId) renderer.pluginId = id;
        if (!renderer.source) renderer.source = id;
    } catch (_) {}
    return renderer;
}

// Attribution hooks into the visualization capability domain (cap:6).
// Guarded no-ops when the domain host isn't loaded (minimal/test pages).
function _notifyVizDomain(id, source) {
    const domain = window.feedBack && window.feedBack.vizDomain;
    if (domain && typeof domain.notifyRendererChanged === 'function') {
        try { domain.notifyRendererChanged(id, source); } catch (_) {}
    }
}

function _noteVizAutoMatch(id, matched) {
    const domain = window.feedBack && window.feedBack.vizDomain;
    if (domain && typeof domain.noteAutoMatch === 'function') {
        try { domain.noteAutoMatch(id, matched); } catch (_) {}
    }
}

function _installVizRenderer(renderer, id, source = 'user-select') {
    highway.setRenderer(_tagVizRenderer(renderer, id));
    // Drop any stale notation-view hint now that we have a resolved renderer id.
    // This is also the path used by _autoMatchViz() after it resolves 'auto' to
    // a real plugin id, so the null passed at evaluation start is corrected here.
    _dropStaleNotationHint(id);
    _notifyVizDomain(id, source);
    if (window.v3VenueViz && typeof window.v3VenueViz.notifyRendererInstalled === 'function') {
        window.v3VenueViz.notifyRendererInstalled(id);
    }
}

function setViz(id) {
    // Helper: reset the UI and persisted selection to the built-in
    // "default" entry. Called whenever the requested viz can't be
    // applied (missing factory, factory threw, factory returned a
    // non-conforming renderer) so the picker, localStorage, and the
    // highway's active renderer stay in sync.
    const fallbackToDefault = () => {
        try { localStorage.setItem('vizSelection', 'default'); } catch (_) {}
        const sel = document.getElementById('viz-picker');
        if (sel) sel.value = 'default';
        highway.setRenderer(null);
        _syncVenueVizPlayerClass('default');
        if (window.v3VenueScene3d && typeof window.v3VenueScene3d.syncViz === 'function') {
            window.v3VenueScene3d.syncViz('default');
        }
        _notifyVizDomain('default', 'fallback');
        _maybeShowNotationViewHint('default');
    };

    // When switching away from Auto, reset the closed-state label so the
    // Auto option shows base text the next time the user opens the dropdown.
    // Also cancel any pending viz:renderer:ready listener from the previous
    // Auto match cycle so it can't set a stale label after we've moved on.
    if (id !== 'auto') {
        if (_cancelPendingAutoLabel) { _cancelPendingAutoLabel(); _cancelPendingAutoLabel = null; }
        _setAutoVizLabel(null);
    }

    if (id === 'default' || !id) {
        try { localStorage.setItem('vizSelection', id || 'default'); } catch (_) {}
        const _sel = document.getElementById('viz-picker');
        if (_sel) _sel.value = 'default';
        highway.setRenderer(null);
        _syncVenueVizPlayerClass('default');
        if (window.v3VenueScene3d && typeof window.v3VenueScene3d.syncViz === 'function') {
            window.v3VenueScene3d.syncViz('default');
        }
        _notifyVizDomain('default', 'user-select');
        _maybeShowNotationViewHint('default');
        return;
    }
    if (id === 'auto') {
        try { localStorage.setItem('vizSelection', 'auto'); } catch (_) {}
        _syncVenueVizPlayerClass('auto');
        if (window.v3VenueScene3d && typeof window.v3VenueScene3d.syncViz === 'function') {
            window.v3VenueScene3d.syncViz('auto');
        }
        _autoMatchViz();
        return;
    }
    if (id === 'venue') {
        if (!_canRun3D()) {
            console.warn('viz picker: WebGL2 unavailable, falling back to Classic 2D Highway');
            _markPromoted();
            _showWebGL2FallbackToast();
            fallbackToDefault();
            return;
        }
        const venueFactory = window['feedBackViz_highway_3d'];
        if (typeof venueFactory !== 'function') {
            console.error('viz picker: venue requires feedBackViz_highway_3d');
            fallbackToDefault();
            return;
        }
        let venueRenderer;
        try { venueRenderer = venueFactory(); }
        catch (e) {
            console.error('viz picker: feedBackViz_highway_3d threw for venue mode', e);
            fallbackToDefault();
            return;
        }
        if (!venueRenderer || typeof venueRenderer.draw !== 'function') {
            console.error('viz picker: feedBackViz_highway_3d returned an invalid renderer for venue mode');
            fallbackToDefault();
            return;
        }
        try { localStorage.setItem('vizSelection', 'venue'); } catch (_) {}
        const _venueSel = document.getElementById('viz-picker');
        if (_venueSel) _venueSel.value = 'venue';
        _installVizRenderer(venueRenderer, 'highway_3d');
        _syncVenueVizPlayerClass('venue');
        console.info('[venue-viz] selected venue -> renderer highway_3d, venueClass=true');
        if (window.v3VenueMoodFx && typeof window.v3VenueMoodFx.onVenueVisualizationSelected === 'function') {
            window.v3VenueMoodFx.onVenueVisualizationSelected();
        }
        if (window.v3VenueScene3d && typeof window.v3VenueScene3d.syncViz === 'function') {
            window.v3VenueScene3d.syncViz('venue');
        }
        _maybeShowNotationViewHint('highway_3d');
        return;
    }
    // 3D Highway specifically gates on WebGL2. Any future WebGL viz
    // plugin should declare its own probe — for now the bundled 3D
    // Highway is the only viz with this requirement, so the gate is
    // hardcoded. Falling back to 'default' (Classic 2D) keeps the
    // picker in sync; toast informs the user.
    if (id === 'highway_3d' && !_canRun3D()) {
        console.warn('viz picker: WebGL2 unavailable, falling back to Classic 2D Highway');
        _markPromoted();
        _showWebGL2FallbackToast();
        fallbackToDefault();
        return;
    }
    const factory = window['feedBackViz_' + id];
    if (typeof factory !== 'function') {
        console.error(`viz picker: factory feedBackViz_${id} not available`);
        fallbackToDefault();
        return;
    }
    let renderer;
    try { renderer = factory(); }
    catch (e) {
        console.error(`viz picker: factory feedBackViz_${id} threw`, e);
        fallbackToDefault();
        return;
    }
    // Validate shape — highway.setRenderer will itself fall back to
    // default on a bad renderer, but without this check the UI and
    // localStorage would still advertise the broken selection.
    if (!renderer || typeof renderer.draw !== 'function') {
        console.error(`viz picker: factory feedBackViz_${id} returned an invalid renderer (missing draw)`);
        fallbackToDefault();
        return;
    }
    // Persist only once we know the renderer is valid.
    try { localStorage.setItem('vizSelection', id); } catch (_) {}
    _installVizRenderer(renderer, id);
    _syncVenueVizPlayerClass(id);
    if (window.v3VenueScene3d && typeof window.v3VenueScene3d.syncViz === 'function') {
        window.v3VenueScene3d.syncViz(id);
    }
    _maybeShowNotationViewHint(id);
}

// Auto mode: evaluate each registered viz factory's static
// `matchesArrangement(songInfo)` predicate and install the first
// matching renderer. No match → fall back to the built-in 2D highway.
//
// vizSelection stays 'auto' across invocations so the next song:ready
// re-evaluates. An explicit picker choice overrides Auto by persisting
// a different vizSelection.
//
// Enumerates viz plugins by walking the picker's own <option> list —
// that's the canonical set built by _populateVizPicker above and keeps
// us from needing a second module-level registry.
// Helper: update the closed-state label of the Auto option to show what was resolved.
// Resets to the base label when called with no argument (at evaluation start).
// _autoVizBaseLabel is captured from the DOM on first call so the reset text
// always matches the initial markup rather than a hardcoded duplicate.
let _autoVizBaseLabel = null;
function _setAutoVizLabel(resolvedText) {
    const opt = document.querySelector('#viz-picker option[value="auto"]');
    if (!opt) return;
    if (_autoVizBaseLabel === null) _autoVizBaseLabel = opt.text;
    opt.text = resolvedText != null ? `Auto \u2192 ${resolvedText}` : _autoVizBaseLabel;
}

// Holds a cleanup function for the pending viz:renderer:ready listener
// registered by _autoMatchViz(). Called at the start of each new evaluation
// to remove any listener left over from the previous match cycle.
let _cancelPendingAutoLabel = null;

// One-shot (per song) hint shown when a notation-only arrangement falls back
// to the built-in 2D highway. Such arrangements carry no wire notes
// (sloppak-spec §5.3: `file:` may be omitted when `notation:` is present), so
// the default renderer draws an empty board — without this the user is left
// staring at a silently blank highway. Core ships no notation view; point at
// the viz picker instead.
let _notationHintShownFor = null;
function _showNotationViewHint(arrangementIndex, activeVizId) {
    const filename = (window.feedBack && window.feedBack.currentSong
        && window.feedBack.currentSong.filename) || '';
    if (_notationHintShownFor === filename) return;
    _notationHintShownFor = filename;
    const player = document.getElementById('player');
    if (!player) return;
    const prev = document.getElementById('notation-view-hint');
    if (prev) prev.remove();
    const el = document.createElement('div');
    el.id = 'notation-view-hint';
    el.className = 'notation-view-hint';
    el.dataset.filename = filename;
    if (arrangementIndex != null) el.dataset.arrangementIndex = String(arrangementIndex);
    if (activeVizId) el.dataset.vizId = String(activeVizId);
    el.textContent = 'This arrangement is notation-only — the built-in highway has nothing to draw. '
        + 'Install a notation view plugin (e.g. Staff View or Keys Highway 3D) and select it in the visualization picker.';
    const close = document.createElement('button');
    close.className = 'notation-view-hint-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', () => el.remove());
    el.appendChild(close);
    player.appendChild(el);
    setTimeout(() => { el.remove(); }, 15000);
}

// Decide whether the active song needs the notation-view hint: the song is
// notation-only (has_notation + zero wire notes on the active arrangement)
// AND the given viz doesn't claim it via matchesArrangement. Covers both the
// Auto fallthrough (activeVizId='default') and explicit selections, where the
// renderer persists across songs — e.g. the fresh-install default highway_3d
// would otherwise show a silently empty 3D board on a notation-only song.
// Returns true when the hint was shown.
// A hint left over from a previous song refers to the wrong arrangement —
// drop it whenever the viz evaluation runs for a different filename, a
// different arrangement index, or a different active viz.
function _dropStaleNotationHint(activeVizId) {
    const stale = document.getElementById('notation-view-hint');
    if (!stale) return;
    const curFilename = (window.feedBack && window.feedBack.currentSong
        && window.feedBack.currentSong.filename) || '';
    if (stale.dataset.filename !== curFilename) { stale.remove(); return; }
    const songInfo = (typeof highway !== 'undefined' && typeof highway.getSongInfo === 'function')
        ? (highway.getSongInfo() || {}) : {};
    const curArrIdx = songInfo.arrangement_index != null ? String(songInfo.arrangement_index) : null;
    if (curArrIdx !== null && stale.dataset.arrangementIndex !== undefined
            && stale.dataset.arrangementIndex !== curArrIdx) {
        stale.remove(); return;
    }
    if (activeVizId && stale.dataset.vizId !== undefined && stale.dataset.vizId !== String(activeVizId)) {
        stale.remove();
    }
}

function _maybeShowNotationViewHint(activeVizId) {
    _dropStaleNotationHint(activeVizId);
    const songInfo = (typeof highway !== 'undefined' && typeof highway.getSongInfo === 'function')
        ? (highway.getSongInfo() || {}) : {};
    const activeArr = Array.isArray(songInfo.arrangements)
        ? songInfo.arrangements.find(a => a.index === songInfo.arrangement_index)
        : null;
    if (!(songInfo.has_notation && activeArr && activeArr.notes === 0)) {
        // Condition no longer holds (arrangement switched to one with notes, or
        // notation flag cleared) — remove any residual hint so it doesn't
        // linger and contradict current state.
        const existing = document.getElementById('notation-view-hint');
        if (existing) existing.remove();
        return false;
    }
    if (activeVizId && activeVizId !== 'default' && activeVizId !== 'auto') {
        const factory = window['feedBackViz_' + activeVizId];
        let claimed = false;
        try {
            claimed = typeof factory === 'function'
                && typeof factory.matchesArrangement === 'function'
                && !!factory.matchesArrangement(songInfo);
        } catch (_) { /* predicate threw — treat as unclaimed */ }
        if (claimed) {
            // Renderer now claims notation — drop any existing hint.
            const existing = document.getElementById('notation-view-hint');
            if (existing) existing.remove();
            return false;
        }
    }
    _showNotationViewHint(songInfo.arrangement_index, activeVizId);
    return true;
}

function _autoMatchViz() {
    const sel = document.getElementById('viz-picker');
    if (!sel) return;
    // Pass null here: sel.value is 'auto', which is never a valid viz-id hint
    // key. Passing 'auto' would incorrectly drop hints whose data-viz-id is
    // 'default' (the resolved renderer after a no-match pass), making the
    // hint unshowable for the rest of the song. Drop using the resolved id
    // happens later inside _installVizRenderer once the id is known.
    _dropStaleNotationHint(null);
    // Cancel any pending viz:renderer:ready listener from a previous match
    // cycle. The song may change before the previous renderer's async init
    // settles; we don't want that stale listener to clobber the new label.
    if (_cancelPendingAutoLabel) { _cancelPendingAutoLabel(); _cancelPendingAutoLabel = null; }
    // Reset label at evaluation start so a stale resolved label never persists
    // if the song changes or the picker re-evaluates with a different outcome.
    _setAutoVizLabel(null);
    const songInfo = (typeof highway !== 'undefined' && typeof highway.getSongInfo === 'function')
        ? (highway.getSongInfo() || {}) : {};
    // Only update the label when a real song is loaded. Before the first
    // song_info frame, getSongInfo() returns {} — leaving the reset state
    // ("Auto (match arrangement)") is correct; we haven't evaluated yet.
    const hasSong = Object.keys(songInfo).length > 0;
    // Options are stable in DOM order, which matches what users see in
    // the picker. The underlying order comes from /api/plugins →
    // _populateVizPicker, and /api/plugins reflects the order the
    // plugin loader discovered plugins in — plugins/__init__.py walks
    // `sorted(plugins_base_dir.iterdir())`, i.e. sorted by the on-disk
    // PLUGIN DIRECTORY name (e.g. "feedBack-plugin-drums" sorts
    // before "feedBack-plugin-piano"), not by the plugin id declared
    // in plugin.json. Two consequences worth noting:
    //   1. First match wins among registered viz plugins — keep each
    //      plugin's matchesArrangement predicate narrow to avoid
    //      stealing songs from more specialized viz.
    //   2. If you need a strict priority when multiple plugins match
    //      the same song, name the higher-priority plugin's directory
    //      earlier alphabetically. The picker dropdown reveals the
    //      actual tiebreaker at a glance.
    const candidateIds = Array.from(sel.options)
        .map(o => o.value)
        .filter(v => v !== 'auto' && v !== 'default');
    for (const id of candidateIds) {
        const factory = window['feedBackViz_' + id];
        if (typeof factory !== 'function') continue;
        // If the factory statically declares contextType='webgl2', gate on
        // WebGL2 availability so a match never installs a renderer that'll
        // fail at init. This is the generic version of the old hard-coded
        // highway_3d check — any future WebGL2 viz gets the same protection
        // for free without needing a special-case here.
        const factoryCtxType = typeof factory.contextType === 'string' ? factory.contextType : '2d';
        if (factoryCtxType === 'webgl2' && !_canRun3D()) continue;
        const predicate = factory.matchesArrangement;
        if (typeof predicate !== 'function') continue;
        let matched = false;
        try { matched = !!predicate(songInfo); }
        catch (err) {
            console.error(`viz auto: matchesArrangement for ${id} threw`, err);
            continue;
        }
        if (!matched) continue;
        let renderer;
        try { renderer = factory(); }
        catch (err) {
            console.error(`viz auto: factory feedBackViz_${id} threw`, err);
            continue;
        }
        if (!renderer || typeof renderer.draw !== 'function') {
            console.error(`viz auto: factory feedBackViz_${id} returned an invalid renderer (missing draw)`);
            continue;
        }
        // Deliberately NOT persisting id — vizSelection stays 'auto' so
        // the next song:ready re-evaluates against the new arrangement.
        //
        // Register the viz:renderer:ready listener BEFORE setRenderer() so we
        // don't miss the event for sync renderers (no readyPromise), which emit
        // it immediately inside setRenderer(). The _onReady guard still checks
        // sel.value so a sync init failure (viz:reverted → sel.value='default')
        // that fires during setRenderer() is handled correctly — the listener
        // fires but finds sel.value !== 'auto' and skips the label update.
        if (hasSong) {
            const matchedOpt = Array.from(sel.options).find(o => o.value === id);
            const labelText = matchedOpt ? matchedOpt.text : id;
            function _onReady() { if (sel.value === 'auto') _setAutoVizLabel(labelText); }
            window.feedBack.on('viz:renderer:ready', _onReady, { once: true });
            _cancelPendingAutoLabel = () => window.feedBack.off('viz:renderer:ready', _onReady);
        }
        _installVizRenderer(renderer, id, 'auto-match');
        _noteVizAutoMatch(id, true);
        return;
    }
    // No match — restore the built-in 2D highway. setRenderer(null) is
    // a no-op when the default is already active. If the previous Auto
    // pick was a WebGL renderer, highway.setRenderer() handles the
    // context-type change by replacing the canvas element (cloneNode +
    // replaceWith) so the default 2D renderer's getContext('2d') always
    // succeeds — no canvas-lock limitation here.
    highway.setRenderer(null);
    _notifyVizDomain('default', 'auto-match');
    _noteVizAutoMatch('default', false);
    // Update the label so the user can see Auto resolved to the built-in
    // highway. Read from the DOM rather than hard-coding the name so a
    // future rename of the default entry is automatically reflected.
    if (hasSong) {
        const defaultOpt = Array.from(sel.options).find(o => o.value === 'default');
        // Notation-only arrangement falling through to the default renderer:
        // there are no wire notes, so the board would be silently empty.
        // Flag it in the Auto label and show the one-shot install hint.
        if (_maybeShowNotationViewHint('default')) {
            _setAutoVizLabel('no notation view installed');
        } else {
            _setAutoVizLabel(defaultOpt ? defaultOpt.text : null);
        }
    }
}

function formatTime(s) { return `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`; }

// ── A-B Loop ────────────────────────────────────────────────────────────
let loopA = null;
let loopB = null;
// Bumped on every NON-practiceSection loop mutation (direct setLoop from Saved
// Loops / the plugin API, and clearLoop). practiceSection() captures it and bails
// if it changes mid-retry, so a stale section retry can't overwrite a loop the
// user just set/cleared by another path. practiceSection's own setLoop calls pass
// skipSectionSync and do NOT bump it (they must not supersede themselves).
let _loopMutationGen = 0;

function setLoopStart() {
    loopA = _audioTime();
    document.getElementById('btn-loop-a').className = 'px-3 py-1.5 bg-green-900/50 rounded-lg text-xs text-green-300 transition';
    updateLoopUI();
}

function setLoopEnd() {
    if (loopA === null) return;
    loopB = _audioTime();
    if (loopB <= loopA) { loopB = null; return; }
    document.getElementById('btn-loop-b').className = 'px-3 py-1.5 bg-green-900/50 rounded-lg text-xs text-green-300 transition';
    updateLoopUI();
    // Manual A/B arming is a loop mutation like setLoop()'s — emit the same
    // transport event so event-driven consumers (note_detect drill sync) see
    // button-armed loops without having to poll getLoop().
    window.feedBack?.playback?.transportEvent?.('loop-set', { requesterId: 'core.loop', loopA, loopB, loop: { startTime: loopA, endTime: loopB, enabled: true, state: 'active' } });
}

function clearLoop(options) {
    const { emitTransportEvent = true } = options || {};
    // playSong() clears the loop on every song load, so only signal a
    // loop-cleared transport event when a loop was actually active —
    // otherwise every song switch emits a spurious playback:loop-cleared.
    const hadLoop = loopA !== null || loopB !== null;
    _setSectionPracticeMode(false, { skipClearLoop: true });
    loopA = null;
    loopB = null;
    document.getElementById('btn-loop-a').className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-300 transition';
    document.getElementById('btn-loop-b').className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-300 transition';
    document.getElementById('btn-loop-clear').classList.add('hidden');
    document.getElementById('btn-loop-save').classList.add('hidden');
    document.getElementById('loop-label').textContent = '';
    document.getElementById('saved-loops').value = '';
    _sectionPracticeSelected = -1;
    _sectionPracticeWholeSection = false;
    _sectionPracticeSavedPartIndex = 0;
    _updateSectionPracticeHighlight(_audioTime());
    if (hadLoop && emitTransportEvent && typeof window !== 'undefined') {
        window.feedBack?.playback?.transportEvent?.('loop-cleared', {
            requesterId: 'core.loop',
            reason: 'app loop cleared',
            loop: { enabled: false, state: 'inactive' },
        });
    }
}

// Resync #saved-loops + #btn-loop-delete with the currently-active
// loopA/loopB. Used by both setLoop's success path (so plugin-driven
// loops show up correctly in the dropdown) and loadSavedLoop's
// failure path (so a cancelled selection reverts to the still-active
// loop). Without this sync, deleteSelectedLoop could target a stale
// option that doesn't match the active loop.
function _syncSavedLoopSelection() {
    const sel = document.getElementById('saved-loops');
    const delBtn = document.getElementById('btn-loop-delete');
    if (!sel || !delBtn) return;
    let selected = '';
    if (loopA !== null && loopB !== null) {
        for (const opt of sel.options) {
            if (Number(opt.dataset.start) === loopA && Number(opt.dataset.end) === loopB) {
                selected = opt.value;
                break;
            }
        }
    }
    sel.value = selected;
    delBtn.classList.toggle('hidden', !selected);
}

// Programmatically set both loop endpoints and seek to A. The dropdown
// path (loadSavedLoop) and the plugin-API path (window.feedBack.setLoop)
// both funnel through here so the UI state stays canonical regardless of
// who triggered the loop.
//
// Returns true if the seek landed at A and the loop is now active;
// returns false if the seek was cancelled by teardown or landed off-target
// (JUCE clamp / HTML5 snap > 50ms from A). On false, loopA/loopB are NOT
// committed and the UI is not painted — the prior loop (if any) stays
// active. Throws on invalid inputs.
async function setLoop(a, b, options) {
    const { emitTransportEvent = true, skipSectionSync = false, commitGuard = null } = options || {};
    const aNum = Number(a);
    const bNum = Number(b);
    if (!Number.isFinite(aNum) || !Number.isFinite(bNum) || bNum <= aNum) {
        throw new Error(`setLoop: requires finite a and b with b > a (got a=${a}, b=${b})`);
    }
    // Don't arm loopA/loopB before the seek lands — the 60Hz tick's wrap
    // detector (`ct >= loopB`) would trigger startCountIn against
    // half-applied state.
    const r = await _audioSeek(aNum, 'loop-set');
    if (!r.completed || Math.abs(r.to - aNum) > 0.05) return false;
    // Caller-owned staleness gate, re-checked after the awaited seek and before
    // we commit loopA/loopB. practiceSection() passes this so a superseded retry
    // (newer section click, mode turned off, or song/arrangement teardown that
    // happened during the seek) does not arm a stale loop. Returning false here
    // leaves the prior loop (if any) untouched, same as the off-target path.
    if (typeof commitGuard === 'function' && !commitGuard()) return false;
    loopA = aNum;
    loopB = bNum;
    // A direct (non-practice) loop set supersedes any in-flight practiceSection
    // retry; practiceSection passes skipSectionSync and is exempt so it doesn't
    // cancel itself.
    if (!skipSectionSync) _loopMutationGen++;
    document.getElementById('btn-loop-a').className = 'px-3 py-1.5 bg-green-900/50 rounded-lg text-xs text-green-300 transition';
    document.getElementById('btn-loop-b').className = 'px-3 py-1.5 bg-green-900/50 rounded-lg text-xs text-green-300 transition';
    updateLoopUI();
    // Sync the saved-loops dropdown so a plugin-driven setLoop call
    // surfaces the matching saved option (and Delete button) — otherwise
    // the dropdown can stay on a stale selection and deleteSelectedLoop
    // would target the wrong record.
    _syncSavedLoopSelection();
    // practiceSection() passes skipSectionSync: it sets its own section state
    // under a request-gen guard, so the shared setLoop path must NOT re-sync
    // here — otherwise a stale (superseded / mode-off) practiceSection retry
    // that lands inside setLoop would re-arm the loop and flip the mode back on
    // before the caller's gen check can bail. Direct callers (Saved Loops,
    // window.feedBack.setLoop) still sync so their chip selection tracks.
    if (!skipSectionSync && typeof _syncSectionPracticeFromLoop === 'function') {
        _syncSectionPracticeFromLoop();
    }
    if (emitTransportEvent && typeof window !== 'undefined') {
        window.feedBack?.playback?.transportEvent?.('loop-set', { requesterId: 'core.loop', loopA, loopB, loop: { startTime: loopA, endTime: loopB, enabled: true, state: 'active' } });
    }
    return true;
}

function updateLoopUI() {
    const label = document.getElementById('loop-label');
    const hasLoop = loopA !== null && loopB !== null;
    if (hasLoop) {
        label.textContent = `${formatTime(loopA)} → ${formatTime(loopB)}`;
        document.getElementById('btn-loop-clear').classList.remove('hidden');
        document.getElementById('btn-loop-save').classList.remove('hidden');
    } else if (loopA !== null) {
        label.textContent = `${formatTime(loopA)} → ?`;
        document.getElementById('btn-loop-clear').classList.add('hidden');
        document.getElementById('btn-loop-save').classList.add('hidden');
    } else {
        label.textContent = '';
    }
    _updateEditRegionBtn();
}

// ── Highway → Editor handoff ("Edit region") ────────────────────────────
// The flip side of the editor's "Loop in 3D" button: jump from the player
// to the Song Editor scrolled to the region you're looking at, edit, then
// (via the editor's Loop-in-3D) come straight back. Reuses the existing
// A/B loop as the region, falling back to the section under the playhead.

// Resolve the region to edit: the active A/B loop if set, else the section
// containing the playhead, else a short window around it. All in seconds.
function _resolveEditRegion() {
    if (loopA !== null && loopB !== null) return { a: loopA, b: loopB };
    const t = _audioTime();
    try {
        const secs = (highway && typeof highway.getSections === 'function')
            ? highway.getSections() : [];
        if (Array.isArray(secs) && secs.length) {
            let start = null, end = null;
            for (let i = 0; i < secs.length; i++) {
                const st = _sectionPracticeStartTime(secs[i]);
                if (!Number.isFinite(st)) continue;
                if (st <= t + 1e-6) {
                    start = st;
                    const nx = secs[i + 1] ? _sectionPracticeStartTime(secs[i + 1]) : NaN;
                    end = Number.isFinite(nx) ? nx : null;
                } else if (start !== null) {
                    break;
                }
            }
            if (start !== null) return { a: start, b: (end !== null && end > start) ? end : start + 8 };
        }
    } catch (_) { /* fall through to the window default */ }
    return { a: Math.max(0, t - 4), b: t + 4 };
}

/* @pure:editor-pending-view:start */
function _buildEditorPendingViewPure(filename, arrangement, region, opts) {
    const options = opts || {};
    const view = {
        filename,
        arrangement: Number.isFinite(arrangement) && arrangement >= 0 ? arrangement : 0,
        barSel: region ? { startTime: region.a, endTime: region.b } : null,
    };
    if (options.returnToHighway) view.returnToHighway = true;
    if (typeof options.cursorTime === 'number') {
        view.cursorTime = options.cursorTime;
    } else if (region && typeof region.a === 'number') {
        view.cursorTime = region.a;
    }
    if (typeof options.scrollX === 'number') view.scrollX = Math.max(0, options.scrollX);
    if (typeof options.zoom === 'number' && options.zoom > 0) view.zoom = options.zoom;
    return view;
}
/* @pure:editor-pending-view:end */

// Enable "Edit region" whenever the editor plugin is present and a song is
// loaded; show "↩ Editor" only while a return context is pending.
function _updateEditRegionBtn() {
    const hasEditor = typeof window.editSong === 'function';
    const editBtn = document.getElementById('btn-edit-region');
    if (editBtn) {
        editBtn.classList.toggle('hidden', !hasEditor);
        editBtn.disabled = !currentFilename;
    }
    const retBtn = document.getElementById('btn-return-editor');
    if (retBtn) {
        retBtn.classList.toggle('hidden', !(hasEditor && window._highwayReturnCtx));
    }
}

// Open the Song Editor at the current region.
function editRegionInEditor() {
    if (typeof window.editSong !== 'function' || !currentFilename) return;
    const region = _resolveEditRegion();
    let arrangement = 0;
    try {
        const si = highway && typeof highway.getSongInfo === 'function' ? highway.getSongInfo() : null;
        if (si && typeof si.arrangement_index === 'number' && si.arrangement_index >= 0) {
            arrangement = si.arrangement_index;
        }
    } catch (_) { /* default to 0 */ }
    window._editorPendingView = _buildEditorPendingViewPure(currentFilename, arrangement, region, {
        returnToHighway: true,
    });
    window.editSong(currentFilename);
}
window.editRegionInEditor = editRegionInEditor;

// Return from the editor to the highway loop we came from (set by the
// song:ready applier above). The editor consumes _editorPendingView to
// restore the exact edit position; here we just navigate back.
function returnToEditorFromHighway() {
    const ctx = window._highwayReturnCtx;
    if (!ctx || typeof window.editSong !== 'function') return;
    window._highwayReturnCtx = null;
    const region = ctx.barSel
        ? { a: ctx.barSel.startTime, b: ctx.barSel.endTime }
        : null;
    window._editorPendingView = _buildEditorPendingViewPure(ctx.filename, ctx.arrangement, region, {
        scrollX: ctx.scrollX,
        zoom: ctx.zoom,
        cursorTime: ctx.cursorTime,
    });
    window.editSong(ctx.filename);
}
window.returnToEditorFromHighway = returnToEditorFromHighway;

// ── Section Practice Bar ────────────────────────────────────────────────
// One-click looping over song section markers (highway.getSections —
// same array as 3D highway bundle.sections / "Now / Up Next").
// Reuses setLoop() so manual A/B controls and saved loops stay canonical.
let _sectionPracticeRanges = [];
let _sectionPracticeSelected = -1;
let _sectionPracticeFollowParent = -1;
let _sectionPracticeDurSynced = false;
let _sectionPracticeLogged = false;
let _sectionPracticeHooked = false;
let _sectionPracticeRetryTimer = null;
let _sectionPracticeLastPlayableCount = 0;
let _sectionPracticePlayablePopulateRerendered = false;
// Last-rendered parent count, so the bar can re-render when the parent layout
// changes after the initial render — notably when the synthetic "Start" section
// appears as notes-before-the-first-marker stream in late.
let _sectionPracticeLastParentCount = -1;
// Start-time identity of the active parent, tracked so it can be remapped to the
// correct index when the parent layout shifts (a late "Start" prepend moves every
// real parent by one) instead of leaving the raw index pointing at the wrong one.
let _sectionPracticeActiveParentStart = NaN;
let _sectionPracticeMode = false;
let _sectionPracticeActiveParent = -1;
let _sectionPracticeWholeSection = false;
let _sectionPracticeSavedPartIndex = 0;
// Monotonic token to cancel stale practiceSection() retries: a newer click
// (or a song/arrangement change, which also bumps _audioSeekGen) supersedes
// any in-flight retry loop so it can't re-arm the wrong loop/count-in.
let _sectionPracticeRequestGen = 0;
// >0 while a practiceSection() request is awaiting its loop. While set,
// _syncSectionPracticeFromLoop() (e.g. from a mid-await bar re-render) must not
// reconcile against the half-applied / previous loop — practiceSection owns the
// section state and applies it once its own gen check passes.
let _sectionPracticeRequestInFlight = 0;

function _setSectionPracticeMode(on, opts = {}) {
    const next = !!on;
    if (next === _sectionPracticeMode && !opts.force) return;
    _sectionPracticeMode = next;
    const cb = document.getElementById('section-practice-mode');
    if (cb) cb.checked = _sectionPracticeMode;
    // Surface the "looping" state on the collapsed pill so the user can tell
    // Section Practice is armed without opening the popover.
    const pill = document.getElementById('section-practice-pill');
    if (pill) pill.classList.toggle('section-practice-pill--active', _sectionPracticeMode);
    _sectionPracticeFollowParent = -1;
    if (_sectionPracticeMode) {
        if (opts.defaultWholeOn) {
            _sectionPracticeWholeSection = true;
        }
        _updateSectionPracticeHighlight(_audioTime());
        if (opts.defaultWholeOn) {
            _syncSectionPracticePieceUi();
        }
    } else {
        // Turning the feature off must cancel any in-flight practiceSection()
        // retry: otherwise a stale setLoop() that lands after the user unchecks
        // Section Practice would re-arm the loop, flip the mode back on via
        // _syncSectionPracticeFromLoop(), and restart playback through
        // startCountIn(). Bumping the request gen makes the pending retry bail.
        _sectionPracticeRequestGen++;
        // Cancel any pending count-in: every section-practice teardown routes
        // through here (mode toggle off, clearLoop, and _hideSectionPracticeBar
        // on song/arrangement change), so a countdown started by a prior section
        // click must not resume playback after the user has turned practice off.
        _cancelCountIn();
        _sectionPracticeSelected = -1;
        _sectionPracticeWholeSection = false;
        _sectionPracticeSavedPartIndex = 0;
        _updateSectionPracticeHighlight(_audioTime());
        if (!opts.skipClearLoop && (loopA !== null || loopB !== null)) {
            clearLoop();
        }
    }
}

function onSectionPracticeModeChange() {
    const cb = document.getElementById('section-practice-mode');
    if (!cb) return;
    const turningOn = cb.checked && !_sectionPracticeMode;
    _setSectionPracticeMode(cb.checked, { defaultWholeOn: turningOn });
}

function _resetSectionPracticeLog() {
    _sectionPracticeLogged = false;
    _sectionPracticeLastPlayableCount = 0;
    _sectionPracticePlayablePopulateRerendered = false;
}

function _sectionPracticeHighway() {
    return window.highway || (typeof highway !== 'undefined' ? highway : null);
}

function _sectionPracticeDuration() {
    const d = _audioDuration();
    if (d && Number.isFinite(d) && d > 0) return d;
    const cd = window.feedBack?.currentSong?.duration;
    return (cd && Number.isFinite(cd) && cd > 0) ? cd : 0;
}

function _sectionPracticeSourceSections() {
    const hw = _sectionPracticeHighway();
    if (!hw || typeof hw.getSections !== 'function') return [];
    const raw = hw.getSections();
    return Array.isArray(raw) ? raw : [];
}

function _sectionPracticeStartTime(s) {
    const t = s.time ?? s.startTime ?? s.start_time ?? s.start;
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
}

function _sectionPracticeBaseName(rawName, fallbackIndex) {
    let s = (typeof rawName === 'string' ? rawName : '').trim();
    if (!s) s = `Section ${fallbackIndex + 1}`;
    // Normalise separators and strip common trailing digits like "Chorus 2"
    s = s.replace(/_/g, ' ');
    s = s.replace(/\s*\d+$/u, '');
    const lower = s.toLowerCase();
    const canonical = {
        intro: 'Intro',
        verse: 'Verse',
        chorus: 'Chorus',
        bridge: 'Bridge',
        solo: 'Solo',
        riff: 'Riff',
        outro: 'Outro',
    }[lower];
    if (canonical) return canonical;
    // Fallback: title-case words
    return lower.split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ') || `Section ${fallbackIndex + 1}`;
}

const _SECTION_PRACTICE_START_GAP_SEC = 0.05;

function _sectionPracticeNoteTime(note) {
    const t = note?.t ?? note?.time ?? note?.start_time ?? note?.start;
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
}

function _sectionPracticePlayableCount() {
    const hw = _sectionPracticeHighway();
    if (!hw) return 0;
    let count = 0;
    if (typeof hw.getNotes === 'function') {
        const notes = hw.getNotes();
        if (notes?.length) count += notes.length;
    }
    if (typeof hw.getChords === 'function') {
        const chords = hw.getChords();
        if (chords?.length) count += chords.length;
    }
    return count;
}

function _sectionPracticeHasNotesBefore(beforeTime) {
    const hw = _sectionPracticeHighway();
    if (!hw) return false;
    const cutoff = Number(beforeTime);
    if (!Number.isFinite(cutoff)) return false;
    const sources = [];
    if (typeof hw.getNotes === 'function') {
        const notes = hw.getNotes();
        if (notes?.length) sources.push(notes);
    }
    if (typeof hw.getChords === 'function') {
        const chords = hw.getChords();
        if (chords?.length) sources.push(chords);
    }
    for (let s = 0; s < sources.length; s++) {
        const items = sources[s];
        for (let i = 0; i < items.length; i++) {
            const t = _sectionPracticeNoteTime(items[i]);
            if (Number.isFinite(t) && t < cutoff) return true;
        }
    }
    return false;
}

function _maybeRerenderSectionPracticeOnPlayableLoad() {
    const count = _sectionPracticePlayableCount();
    const prev = _sectionPracticeLastPlayableCount;
    _sectionPracticeLastPlayableCount = count;
    if (!_sectionPracticeSourceSections().length || !_sectionPracticeBarIsReady()) return;
    // Re-render whenever the parent layout changes after the bar is up — the
    // synthetic "Start" section can appear (±1 parent) once a note before the
    // first marker streams in, which would otherwise leave the DOM chip indices
    // out of sync with _buildSectionParents() (clicks/highlights hitting the
    // wrong section). _buildSectionParents() is memoized, so this is cheap.
    const parents = _buildSectionParents();
    const parentCount = parents.length;
    if (parentCount !== _sectionPracticeLastParentCount) {
        // Remap the active parent by start-time identity before re-rendering: a
        // late "Start" prepend shifts every real parent's index, so the raw
        // index would otherwise point at the wrong section (mis-highlighting and
        // breaking whole/prev/next). Selected/part indices are within-parent and
        // unaffected. Skip when no active parent or no prior snapshot.
        if (_sectionPracticeActiveParent >= 0 && Number.isFinite(_sectionPracticeActiveParentStart)) {
            const remapped = parents.findIndex(
                (p) => Math.abs(p.start - _sectionPracticeActiveParentStart) < 0.001,
            );
            if (remapped >= 0) _sectionPracticeActiveParent = remapped;
        }
        _sectionPracticeLastParentCount = parentCount;
        renderSectionPracticeBar();
        _sectionPracticeActiveParentStart =
            (_sectionPracticeActiveParent >= 0 && parents[_sectionPracticeActiveParent])
                ? parents[_sectionPracticeActiveParent].start : NaN;
        return;
    }
    // Keep the active-parent start snapshot fresh while the layout is stable, so
    // it holds the correct pre-change value when the layout next shifts.
    _sectionPracticeActiveParentStart =
        (_sectionPracticeActiveParent >= 0 && parents[_sectionPracticeActiveParent])
            ? parents[_sectionPracticeActiveParent].start : NaN;
    if (_sectionPracticePlayablePopulateRerendered) return;
    if (prev !== 0 || count === 0) return;
    _sectionPracticePlayablePopulateRerendered = true;
    renderSectionPracticeBar();
}

// _buildSectionParents() runs on the 60 Hz highlight path, so memoize it.
// The parent layout is a pure function of the highway's section list (a
// stable array reference per song), the song duration, and whether any
// notes/chords precede the first marker (the synthetic "Start" section).
// That last input can flip while WS note chunks are still streaming in, so
// the note/chord counts are part of the key; once a song is fully loaded
// all four inputs stabilize and the per-frame call becomes a cache hit.
// Every call site uses the result read-only, so returning the cached array
// reference is safe.
let _sectionParentsCache = null;
let _sectionParentsCacheRaw = null;
let _sectionParentsCacheDur = -1;
let _sectionParentsCacheNoteLen = -1;
let _sectionParentsCacheChordLen = -1;

function _buildSectionParents() {
    const raw = _sectionPracticeSourceSections();
    if (!raw.length) return [];
    const dur = _sectionPracticeDuration();
    const hw = _sectionPracticeHighway();
    const noteLen = (hw && typeof hw.getNotes === 'function' && hw.getNotes()?.length) || 0;
    const chordLen = (hw && typeof hw.getChords === 'function' && hw.getChords()?.length) || 0;
    if (_sectionParentsCache !== null
        && _sectionParentsCacheRaw === raw
        && _sectionParentsCacheDur === dur
        && _sectionParentsCacheNoteLen === noteLen
        && _sectionParentsCacheChordLen === chordLen) {
        return _sectionParentsCache;
    }
    const sorted = [...raw].sort((a, b) => _sectionPracticeStartTime(a) - _sectionPracticeStartTime(b));
    // Step 1: collapse consecutive same-name markers into logical groups.
    const groups = [];
    for (let i = 0; i < sorted.length; i++) {
        const start = _sectionPracticeStartTime(sorted[i]);
        if (!Number.isFinite(start)) continue;
        const baseName = _sectionPracticeBaseName(sorted[i].name, groups.length);
        const prev = groups[groups.length - 1];
        if (prev && prev.baseName === baseName) {
            prev.lastIndex = i;
        } else {
            groups.push({ baseName, firstIndex: i, lastIndex: i });
        }
    }
    if (!groups.length) return [];
    // Step 2: assign musician-friendly labels with counters (Verse 1, Verse 2, …).
    const counters = Object.create(null);
    const ranges = [];
    for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        const base = g.baseName;
        const count = (counters[base] || 0) + 1;
        counters[base] = count;
        const label = `${base} ${count}`;
        const firstSec = sorted[g.firstIndex];
        const start = _sectionPracticeStartTime(firstSec);
        if (!Number.isFinite(start)) continue;
        let end;
        if (gi + 1 < groups.length) {
            const nextFirst = sorted[groups[gi + 1].firstIndex];
            end = _sectionPracticeStartTime(nextFirst);
        } else {
            end = dur;
        }
        if (!Number.isFinite(end) || end <= start) {
            end = dur > start ? dur : start + 4;
        }
        ranges.push({ name: label, start, end });
    }
    if (ranges.length > 0) {
        const firstStart = Number(ranges[0].start);
        if (Number.isFinite(firstStart) && firstStart > _SECTION_PRACTICE_START_GAP_SEC
            && _sectionPracticeHasNotesBefore(firstStart)) {
            ranges.unshift({ name: 'Start', start: 0, end: firstStart });
        }
    }
    _sectionParentsCache = ranges;
    _sectionParentsCacheRaw = raw;
    _sectionParentsCacheDur = dur;
    _sectionParentsCacheNoteLen = noteLen;
    _sectionParentsCacheChordLen = chordLen;
    return ranges;
}

function _sectionPracticeResetSelectionUi() {
    _sectionPracticeActiveParent = -1;
    _sectionPracticeSelected = -1;
    _sectionPracticeWholeSection = false;
    _sectionPracticeSavedPartIndex = 0;
    _sectionPracticeRanges = [];
}

function _sectionPracticeSourcePhrases() {
    const hw = _sectionPracticeHighway();
    if (!hw || typeof hw.getPracticePhrases !== 'function') return null;
    const raw = hw.getPracticePhrases();
    return (raw && raw.length) ? raw : null;
}

function _buildPhrasePartsForParent(parent) {
    if (!parent) return [];
    const dur = _sectionPracticeDuration();
    const windowStart = parent.start;
    const windowEnd = parent.end;
    const phrases = _sectionPracticeSourcePhrases();
    const parts = [];

    if (phrases) {
        const inWindow = phrases.filter(
            (ph) => ph.start_time >= windowStart - 0.001 && ph.start_time < windowEnd - 0.001,
        );
        if (inWindow.length) {
            for (let i = 0; i < inWindow.length; i++) {
                const ph = inWindow[i];
                let start = ph.start_time;
                let end = ph.end_time;
                if (!Number.isFinite(end) || end > windowEnd) end = windowEnd;
                if (!Number.isFinite(start) || end <= start) continue;
                if (dur && Number.isFinite(dur) && end > dur) end = dur;
                parts.push({ name: parent.name, start, end });
            }
            // Snap first part to section start so the loop aligns with the selected marker
            // when the first in-window phrase iteration begins later (e.g. Chorus 2).
            if (parts.length > 0 && parts[0].start > windowStart) {
                parts[0].start = windowStart;
            }
            return parts;
        }
    }

    let start = windowStart;
    let end = windowEnd;
    if (dur && Number.isFinite(dur) && end > dur) end = dur;
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        parts.push({ name: parent.name, start, end });
    }
    return parts;
}

function _buildSectionPracticeRanges() {
    if (_sectionPracticeActiveParent < 0) return [];
    const parents = _buildSectionParents();
    const parent = parents[_sectionPracticeActiveParent];
    if (!parent) return [];
    return _buildPhrasePartsForParent(parent);
}

function _sectionPracticeActiveParentRange() {
    if (_sectionPracticeActiveParent < 0) return null;
    const parents = _buildSectionParents();
    const parent = parents[_sectionPracticeActiveParent];
    if (!parent) return null;
    const dur = _sectionPracticeDuration();
    let end = Number(parent.end);
    const start = Number(parent.start);
    if (dur && Number.isFinite(dur) && end > dur) end = dur;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    return { name: parent.name, start, end };
}

function _sectionPracticeResolveLoopTarget(index, opts = {}) {
    if (opts.whole) {
        return _sectionPracticeActiveParentRange();
    }
    return _sectionPracticeRanges[index] ?? null;
}

function _formatSectionPracticeName(name) {
    return name.replace(/_/g, ' ');
}

const _SECTION_PRACTICE_CHIP_KINDS = new Set([
    'intro', 'verse', 'chorus', 'bridge', 'solo', 'riff', 'outro',
]);

function _sectionPracticeChipKindClass(name, index) {
    const base = _sectionPracticeBaseName(name, index);
    const kind = base.toLowerCase();
    if (!_SECTION_PRACTICE_CHIP_KINDS.has(kind)) return '';
    return ` section-practice-chip--${kind}`;
}

function _sectionPracticeWholeCheckboxHtml() {
    return '<label class="section-practice-whole-wrap" title="Loop the whole selected section">'
        + '<input type="checkbox" id="section-practice-whole" onchange="onSectionPracticeWholeChange()">'
        + '<span class="section-practice-whole-text">Full section</span>'
        + '</label>';
}

function _sectionPracticePieceRowHtml() {
    return '<div id="section-practice-piece-row" class="section-practice-row section-practice-piece-row">'
        + '<span id="section-practice-piece-label" class="section-practice-piece-label" aria-live="polite">Part — of —</span>'
        + '<button type="button" id="section-practice-piece-prev" class="section-practice-chip" onclick="onPhrasePrev()">◀ Previous</button>'
        + '<button type="button" id="section-practice-piece-next" class="section-practice-chip" onclick="onPhraseNext()">Next ▶</button>'
        + '</div>';
}

function _sectionPracticeMainRow() {
    const bar = document.getElementById('section-practice-bar');
    if (!bar) return null;
    return bar.querySelector('.section-practice-controls-row')
        || bar.querySelector('.section-practice-primary-row')
        || bar.querySelector('.section-practice-row:not(.section-practice-piece-row):not(.section-practice-chips-row)');
}

function _migrateSectionPracticeDomLayout(bar) {
    if (!bar || bar.querySelector('.section-practice-controls-row')) return;

    const pieceRow = document.getElementById('section-practice-piece-row');
    const scroll = document.getElementById('section-practice-scroll');
    const modeWrap = bar.querySelector('.section-practice-mode-wrap');
    const wholeWrap = bar.querySelector('.section-practice-whole-wrap');
    let label = bar.querySelector('.section-practice-label');

    const controlsRow = document.createElement('div');
    controlsRow.className = 'section-practice-row section-practice-controls-row';
    if (modeWrap) controlsRow.appendChild(modeWrap);
    if (wholeWrap) controlsRow.appendChild(wholeWrap);
    if (pieceRow) controlsRow.appendChild(pieceRow);

    const chipsRow = document.createElement('div');
    chipsRow.className = 'section-practice-row section-practice-chips-row';
    if (label) {
        chipsRow.appendChild(label);
    } else {
        label = document.createElement('span');
        label.className = 'section-practice-label';
        label.textContent = 'Sections:';
        chipsRow.appendChild(label);
    }
    if (scroll) chipsRow.appendChild(scroll);

    bar.replaceChildren(controlsRow, chipsRow);
}

function _sectionPracticeBarInnerHtml() {
    return '<div class="section-practice-row section-practice-controls-row">'
        + '<label class="section-practice-mode-wrap" title="Loop the selected section until turned off">'
        + '<input type="checkbox" id="section-practice-mode" onchange="onSectionPracticeModeChange()">'
        + '<span class="section-practice-mode-text">Practice Section</span>'
        + '</label>'
        + _sectionPracticeWholeCheckboxHtml()
        + _sectionPracticePieceRowHtml()
        + '</div>'
        + '<div class="section-practice-row section-practice-chips-row">'
        + '<span class="section-practice-label">Sections:</span>'
        + '<div id="section-practice-scroll" class="section-practice-scroll" role="toolbar"></div>'
        + '</div>';
}

function _ensureSectionPracticeWholeCheckbox() {
    const existing = document.getElementById('section-practice-whole');
    const mainRow = _sectionPracticeMainRow();
    if (!mainRow) return;
    if (existing) {
        const wrap = existing.closest('.section-practice-whole-wrap');
        if (wrap && !mainRow.contains(wrap)) {
            const modeWrap = mainRow.querySelector('.section-practice-mode-wrap');
            if (modeWrap) modeWrap.insertAdjacentElement('afterend', wrap);
            else mainRow.insertBefore(wrap, mainRow.firstChild);
        }
        return;
    }
    const modeWrap = mainRow.querySelector('.section-practice-mode-wrap');
    if (modeWrap) {
        modeWrap.insertAdjacentHTML('afterend', _sectionPracticeWholeCheckboxHtml());
    } else {
        mainRow.insertAdjacentHTML('afterbegin', _sectionPracticeWholeCheckboxHtml());
    }
}

function _sectionPracticeCurrentPartIndex() {
    const total = _sectionPracticeRanges.length;
    if (!total) return 0;
    if (!_sectionPracticeWholeSection && _sectionPracticeSelected >= 0) {
        return Math.min(_sectionPracticeSelected, total - 1);
    }
    if (_sectionPracticeSavedPartIndex >= 0) {
        return Math.min(_sectionPracticeSavedPartIndex, total - 1);
    }
    return 0;
}

function _sectionPracticePillHtml() {
    return '<button type="button" id="section-practice-pill" class="section-practice-pill"'
        + ' aria-haspopup="dialog" aria-expanded="false" aria-controls="section-practice-bar"'
        + ' aria-label="Section practice"'
        + ' onclick="toggleSectionPracticePopover()" title="Section practice">'
        + '<span class="section-practice-pill-icon" aria-hidden="true">'
        + '<svg class="v3-rail-svg section-practice-pill-svg" viewBox="0 0 24 24">'
        + '<path d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4M12,6A6,6 0 0,0 6,12A6,6 0 0,0 12,18A6,6 0 0,0 18,12A6,6 0 0,0 12,6M12,8A4,4 0 0,1 16,12A4,4 0 0,1 12,16A4,4 0 0,1 8,12A4,4 0 0,1 12,8M12,10A2,2 0 0,0 10,12A2,2 0 0,0 12,14A2,2 0 0,0 14,12A2,2 0 0,0 12,10Z"/>'
        + '</svg></span>'
        + '<span class="section-practice-pill-text">Practice</span>'
        + '<span class="section-practice-pill-caret" aria-hidden="true">▾</span>'
        + '</button>';
}

function _syncSectionPracticePillV3Chrome(isV3) {
    const pill = document.getElementById('section-practice-pill');
    if (!pill) return;
    pill.classList.toggle('v3-rail-icon', isV3);
    let ring = pill.querySelector('.v3-rail-border');
    if (isV3) {
        if (!ring) {
            ring = document.createElement('span');
            ring.className = 'v3-rail-border';
            ring.setAttribute('aria-hidden', 'true');
            pill.insertBefore(ring, pill.firstChild);
        }
        pill.setAttribute('title', 'Practice');
        pill.setAttribute('aria-label', 'Practice');
    } else {
        if (ring) ring.remove();
        pill.setAttribute('title', 'Section practice');
        pill.setAttribute('aria-label', 'Section practice');
    }
}

// Wrap an existing #section-practice-bar in the pill control (creating the
// wrapper + pill if missing). Defensive: works whether the bar came from the
// static markup (already wrapped) or a chrome whose index.html predates the
// pill (e.g. a not-yet-rebased v3 build) — the bar is always reachable as a
// closed popover behind the pill afterward.
function _ensureSectionPracticeControlWrap(bar) {
    if (!bar) return null;
    let ctrl = (bar.closest && bar.closest('.section-practice-control'))
        || document.getElementById('section-practice-control');
    if (ctrl) {
        if (!ctrl.contains(bar)) ctrl.appendChild(bar);
    } else {
        ctrl = document.createElement('div');
        ctrl.id = 'section-practice-control';
        ctrl.className = 'section-practice-control section-practice-control--hidden';
        if (bar.parentNode) bar.parentNode.insertBefore(ctrl, bar);
        ctrl.appendChild(bar);
    }
    if (!ctrl.querySelector('#section-practice-pill')) {
        ctrl.insertAdjacentHTML('afterbegin', _sectionPracticePillHtml());
    }
    // Popover visibility is driven by --open now; clear any legacy hidden class.
    bar.classList.remove('section-practice-bar--hidden');
    _mountSectionPracticeControlSafe(ctrl);
    return ctrl;
}

// Mount the pill control so its popover — whose chip <button>s would otherwise
// be matched by a plugin's `#player-controls > button:last-child` injector
// anchor and throw on insertBefore — lives OUTSIDE #player-controls. Prefers
// #player-footer; otherwise inserts as a sibling immediately before
// #player-controls. Idempotent and never throws on layout variants where
// #player-controls isn't a child of #player-footer (it checks parentage before
// using insertBefore). The v3 rail mount in _placeSectionPracticeControlForChrome
// supersedes this, so a control already in the rail is left alone.
function _mountSectionPracticeControlSafe(ctrl) {
    if (!ctrl) return;
    if (ctrl.closest && ctrl.closest('#v3-player-rail')) return;
    const controls = document.getElementById('player-controls');
    const footer = document.getElementById('player-footer');
    if (footer) {
        if (controls && controls.parentNode === footer) {
            if (ctrl.nextSibling !== controls) footer.insertBefore(ctrl, controls);
        } else if (ctrl.parentNode !== footer) {
            footer.appendChild(ctrl);
        }
        return;
    }
    if (controls && controls.parentNode) {
        if (ctrl.parentNode !== controls.parentNode || ctrl.nextSibling !== controls) {
            controls.parentNode.insertBefore(ctrl, controls);
        }
        return;
    }
    // No footer and #player-controls has no parent (degenerate/detached layout):
    // never nest the popover INSIDE #player-controls — that re-arms the injector
    // bug. Fall back to the player container so the chip buttons stay outside it.
    const player = document.getElementById('player');
    if (player && ctrl.parentNode !== player) player.appendChild(ctrl);
}

// In the v3 chrome the pill becomes a left-rail icon (CSS hides its label and
// opens the popover to the right). app.js owns the toggle/dismiss, so this is
// independent of player-chrome.js's own rail-popover wiring.
// Idempotent + reversible: mounts the control into #v3-player-rail under v3,
// or back out to the footer under v2. Safe to call every frame — it only
// touches the DOM when the placement is actually wrong, so a chrome that flips
// uiVersion (or mounts #v3-player-rail) after the bar is "ready" still gets the
// pill relocated on the next draw tick. See the draw hook's ready path.
function _placeSectionPracticeControlForChrome() {
    const ctrl = document.getElementById('section-practice-control');
    if (!ctrl) return;
    const isV3 = !!(window.feedBack && window.feedBack.uiVersion === 'v3');
    ctrl.classList.toggle('section-practice-control--v3', isV3);
    _syncSectionPracticePillV3Chrome(isV3);
    if (isV3) {
        const rail = document.getElementById('v3-player-rail');
        if (rail) {
            const dot = rail.querySelector('.v3-rail-dot');
            if (dot) {
                // Reorder even when already in the rail but after the dot (or the
                // dot mounted later) so the placement self-corrects each tick.
                if (ctrl.parentElement !== rail || ctrl.nextElementSibling !== dot) {
                    rail.insertBefore(ctrl, dot);
                }
            } else if (ctrl.parentElement !== rail) {
                rail.appendChild(ctrl);
            }
        }
    } else if (ctrl.closest && ctrl.closest('#v3-player-rail')) {
        // Chrome reverted to v2: pull the control out of the rail (detach first
        // so _mountSectionPracticeControlSafe's rail guard doesn't no-op) and
        // re-home it in the footer.
        ctrl.remove();
        _mountSectionPracticeControlSafe(ctrl);
    }
}

function _ensureSectionPracticeDom() {
    let bar = document.getElementById('section-practice-bar');
    if (bar) {
        _ensureSectionPracticeControlWrap(bar);
        _migrateSectionPracticeDomLayout(bar);
        if (!bar.querySelector('#section-practice-piece-row')) {
            const controlsRow = bar.querySelector('.section-practice-controls-row')
                || bar.querySelector('.section-practice-primary-row');
            if (controlsRow) {
                controlsRow.insertAdjacentHTML('beforeend', _sectionPracticePieceRowHtml());
            } else {
                bar.insertAdjacentHTML('beforeend', _sectionPracticePieceRowHtml());
            }
        }
        _ensureSectionPracticeWholeCheckbox();
        bar.querySelector('.section-practice-show-all-wrap')?.remove();
        _placeSectionPracticeControlForChrome();
        return bar;
    }
    const controls = document.getElementById('player-controls');
    const footer = document.getElementById('player-footer');
    if (!footer && !controls) return null;
    bar = document.createElement('div');
    bar.id = 'section-practice-bar';
    bar.className = 'section-practice-bar';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Section practice');
    bar.innerHTML = _sectionPracticeBarInnerHtml();
    const ctrl = document.createElement('div');
    ctrl.id = 'section-practice-control';
    ctrl.className = 'section-practice-control section-practice-control--hidden';
    ctrl.innerHTML = _sectionPracticePillHtml();
    ctrl.appendChild(bar);
    // Mount OUTSIDE #player-controls (in #player-footer, or as its sibling) so
    // the popover's chip <button>s can't be matched by a plugin injector that
    // anchors on `#player-controls > button:last-of-type` (see static/index.html).
    _mountSectionPracticeControlSafe(ctrl);
    _placeSectionPracticeControlForChrome();
    return bar;
}

// "Show" = make the pill available. The bar itself stays a CLOSED popover
// until the user opens it via the pill (toggleSectionPracticePopover).
function _showSectionPracticeBar(bar) {
    const ctrl = (bar && bar.closest && bar.closest('.section-practice-control'))
        || document.getElementById('section-practice-control');
    if (ctrl) ctrl.classList.remove('section-practice-control--hidden');
}

function _sectionPracticePopoverOpen() {
    const bar = document.getElementById('section-practice-bar');
    return !!(bar && bar.classList.contains('section-practice-bar--open'));
}

function _openSectionPracticePopover() {
    const bar = document.getElementById('section-practice-bar');
    if (!bar) return;
    bar.classList.add('section-practice-bar--open');
    const pill = document.getElementById('section-practice-pill');
    if (pill) pill.setAttribute('aria-expanded', 'true');
    _installSectionPracticeDismiss();
}

function _closeSectionPracticePopover() {
    const bar = document.getElementById('section-practice-bar');
    const pill = document.getElementById('section-practice-pill');
    if (bar) {
        const focusWasInside = bar.contains(document.activeElement);
        bar.classList.remove('section-practice-bar--open');
        // Return focus to the pill if it was inside the popover — otherwise it
        // would be stranded on a now-display:none control, which also makes the
        // shortcut gate treat that stale target as interactive and suppress
        // player keys until focus is moved manually.
        if (focusWasInside && pill) pill.focus();
    }
    if (pill) pill.setAttribute('aria-expanded', 'false');
}

function toggleSectionPracticePopover() {
    if (_sectionPracticePopoverOpen()) _closeSectionPracticePopover();
    else _openSectionPracticePopover();
}

let _sectionPracticeDismissBound = false;
function _installSectionPracticeDismiss() {
    if (_sectionPracticeDismissBound) return;
    _sectionPracticeDismissBound = true;
    // Click-outside + Esc close. Bound once on document; the pill's own click is
    // inside #section-practice-control so it never self-closes. Listeners added
    // mid-dispatch don't fire for the opening click, so there's no immediate
    // close race.
    //
    // The click listener uses the CAPTURE phase: the v3 player rail's icon
    // buttons call e.stopPropagation() in their click handler (player-chrome.js
    // wireRail), which kills bubbling before it reaches document. A bubble-phase
    // outside-click dismiss would therefore never fire when the user clicks a
    // rail icon (Plugins, Audio, …) to open another popover, leaving this
    // popover stranded open on top of it. Capture runs before the target's
    // handler, so the stopPropagation can't swallow it. This mirrors the audio
    // mixer popover (audio-mixer.js), which dismisses outside-clicks the same
    // way. (Esc stays bubble-phase — no rail handler stops keydown propagation,
    // so it already reaches us, and capturing it would reorder it ahead of the
    // player's Escape-to-exit handling.)
    document.addEventListener('click', (e) => {
        if (!_sectionPracticePopoverOpen()) return;
        const ctrl = document.getElementById('section-practice-control');
        if (ctrl && ctrl.contains(e.target)) return;
        _closeSectionPracticePopover();
    }, true);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && _sectionPracticePopoverOpen()) _closeSectionPracticePopover();
    });
}

function _hideSectionPracticeBar() {
    _setSectionPracticeMode(false, { skipClearLoop: true });
    _closeSectionPracticePopover();
    const ctrl = document.getElementById('section-practice-control');
    if (ctrl) {
        // Move focus out before hiding the control: a display:none element that
        // still holds focus leaves document.activeElement on it, which the
        // shortcut gate (_shortcutDispatchBlocked) would treat as an interactive
        // target and swallow player keys. Covers the pill (where the close above
        // may have just parked focus) and any bar descendant.
        const ae = document.activeElement;
        if (ae && ctrl.contains(ae) && typeof ae.blur === 'function') ae.blur();
        ctrl.classList.add('section-practice-control--hidden');
    }
    _sectionPracticeRanges = [];
    _sectionPracticeActiveParent = -1;
    _sectionPracticeSelected = -1;
    _sectionPracticeWholeSection = false;
    _sectionPracticeSavedPartIndex = 0;
    _sectionPracticeFollowParent = -1;
    _sectionPracticeDurSynced = false;
    const scroll = document.getElementById('section-practice-scroll');
    if (scroll) scroll.innerHTML = '';
    _syncSectionPracticePieceUi();
}

function _sectionPracticeBarIsReady() {
    // "Ready" = the pill is available (sections exist) and the popover is
    // populated. Independent of whether the popover is currently open, so the
    // draw-hook retry loop settles even while the bar stays collapsed.
    const ctrl = document.getElementById('section-practice-control');
    if (!ctrl || ctrl.classList.contains('section-practice-control--hidden')) return false;
    const scroll = document.getElementById('section-practice-scroll');
    return !!(scroll && scroll.querySelector('[data-parent-idx]'));
}

function _installSectionPracticeDrawHook() {
    if (_sectionPracticeHooked) return;
    const hw = _sectionPracticeHighway();
    if (!hw || typeof hw.addDrawHook !== 'function') return;
    _sectionPracticeHooked = true;
    hw.addDrawHook(() => {
        if (_sectionPracticeSourceSections().length === 0) return;
        _maybeRerenderSectionPracticeOnPlayableLoad();
        if (_sectionPracticeBarIsReady()) { _placeSectionPracticeControlForChrome(); return; }
        renderSectionPracticeBar();
    });
}

function _scheduleSectionPracticeRetries() {
    if (_sectionPracticeRetryTimer) clearTimeout(_sectionPracticeRetryTimer);
    const delays = [0, 50, 200, 500, 1200];
    let i = 0;
    const tick = () => {
        renderSectionPracticeBar();
        i += 1;
        if (i < delays.length && !_sectionPracticeBarIsReady()) {
            _sectionPracticeRetryTimer = setTimeout(tick, delays[i]);
        } else {
            _sectionPracticeRetryTimer = null;
        }
    };
    tick();
}

function _syncSectionPracticePieceUi() {
    const label = document.getElementById('section-practice-piece-label');
    const prev = document.getElementById('section-practice-piece-prev');
    const next = document.getElementById('section-practice-piece-next');
    const wholeCb = document.getElementById('section-practice-whole');
    const total = _sectionPracticeRanges.length;
    const active = _sectionPracticeActiveParent >= 0;
    if (label) {
        if (!active || !total) {
            label.textContent = 'Part — of —';
        } else {
            const idx = _sectionPracticeCurrentPartIndex();
            label.textContent = `Part ${idx + 1} of ${total}`;
        }
    }
    if (wholeCb) {
        wholeCb.checked = _sectionPracticeWholeSection;
    }
    const partIdx = (!active || !total || _sectionPracticeWholeSection)
        ? 0
        : (_sectionPracticeSelected >= 0 ? _sectionPracticeSelected : 0);
    if (prev) {
        prev.disabled = !active || !total || (!_sectionPracticeWholeSection && partIdx <= 0);
    }
    if (next) {
        next.disabled = !active || !total || (!_sectionPracticeWholeSection && partIdx >= total - 1);
    }
}

function renderSectionPracticeBar() {
    _installSectionPracticeDrawHook();
    const raw = _sectionPracticeSourceSections();
    if (!_sectionPracticeLogged) {
        _sectionPracticeLogged = true;
    }
    const parents = _buildSectionParents();
    const bar = _ensureSectionPracticeDom();
    const scroll = document.getElementById('section-practice-scroll');
    if (!bar || !scroll) return;
    if (!parents.length) {
        _hideSectionPracticeBar();
        return;
    }
    if (_sectionPracticeActiveParent >= parents.length) {
        _sectionPracticeResetSelectionUi();
    }
    _showSectionPracticeBar(bar);
    scroll.innerHTML = parents.map((p, i) => {
        const label = _formatSectionPracticeName(p.name);
        const tip = `${label} (${formatTime(p.start)}–${formatTime(p.end)})`;
        const kindClass = _sectionPracticeChipKindClass(p.name, i);
        return `<button type="button" class="section-practice-chip${kindClass}" data-parent-idx="${i}" title="${esc(tip)}" onclick="onSectionParentClick(${i})">${esc(label)}</button>`;
    }).join('');
    _sectionPracticeRanges = _buildSectionPracticeRanges();
    // Reconcile any active A-B loop with the (re)rendered section bar. Called
    // unconditionally so a loop that arrived before the section markers — e.g.
    // a Saved Loop or window.feedBack.setLoop() during song load, when no
    // parent was active yet — still re-selects its chip once markers appear.
    // _syncSectionPracticeFromLoop() scans all parents, so it can activate the
    // matching one; run it before the piece UI so that reflects the result.
    _syncSectionPracticeFromLoop();
    _syncSectionPracticePieceUi();
    _updateSectionPracticeHighlight(_audioTime());
}

async function onSectionParentClick(parentIdx) {
    const parents = _buildSectionParents();
    const idx = Number(parentIdx);
    if (!Number.isFinite(idx) || idx < 0 || idx >= parents.length) return;
    _sectionPracticeActiveParent = idx;
    _sectionPracticeRanges = _buildSectionPracticeRanges();
    _sectionPracticeSelected = -1;
    _sectionPracticeSavedPartIndex = 0;
    _sectionPracticeWholeSection = true;
    _syncSectionPracticePieceUi();
    _updateSectionPracticeHighlight(_audioTime());
    if (_sectionPracticeActiveParentRange() || _sectionPracticeRanges.length) {
        await practiceSection(0, { whole: true });
    }
}

async function onSectionPracticeWholeChange() {
    const cb = document.getElementById('section-practice-whole');
    if (!cb || _sectionPracticeActiveParent < 0) return;
    const total = _sectionPracticeRanges.length;
    if (!total) return;
    if (cb.checked === _sectionPracticeWholeSection) return;
    _sectionPracticeWholeSection = cb.checked;
    if (cb.checked) {
        await practiceSection(_sectionPracticeCurrentPartIndex(), { whole: true });
        return;
    }
    await practiceSection(0);
}

async function onPhrasePrev() {
    const total = _sectionPracticeRanges.length;
    if (!total || _sectionPracticeActiveParent < 0) return;
    if (_sectionPracticeWholeSection) {
        _sectionPracticeWholeSection = false;
        _syncSectionPracticePieceUi();
        await practiceSection(0);
        return;
    }
    const cur = _sectionPracticeSelected >= 0 ? _sectionPracticeSelected : 0;
    if (cur <= 0) return;
    await practiceSection(cur - 1);
}

async function onPhraseNext() {
    const total = _sectionPracticeRanges.length;
    if (!total || _sectionPracticeActiveParent < 0) return;
    if (_sectionPracticeWholeSection) {
        _sectionPracticeWholeSection = false;
        _syncSectionPracticePieceUi();
        await practiceSection(0);
        return;
    }
    const cur = _sectionPracticeSelected >= 0 ? _sectionPracticeSelected : 0;
    if (cur >= total - 1) return;
    await practiceSection(cur + 1);
}

window.onSectionParentClick = onSectionParentClick;
window.onSectionPracticeWholeChange = onSectionPracticeWholeChange;
window.onPhrasePrev = onPhrasePrev;
window.onPhraseNext = onPhraseNext;

// Find which section parent / phrase part the active A-B loop corresponds to.
// Scans ALL parents (not just the active one) so a loop arriving from Saved
// Loops or window.feedBack.setLoop() can re-select the right chip even when
// its parent isn't the currently-active one. Returns { parentIdx, whole } or
// { parentIdx, whole:false, index } (the matching phrase part), or null.
function _sectionPracticeLoopMatch() {
    if (loopA === null || loopB === null) return null;
    const parents = _buildSectionParents();
    for (let parentIdx = 0; parentIdx < parents.length; parentIdx++) {
        const parent = parents[parentIdx];
        let partMatch = -1;
        const parts = _buildPhrasePartsForParent(parent);
        for (let i = 0; i < parts.length; i++) {
            if (Math.abs(parts[i].start - loopA) < 0.05 && Math.abs(parts[i].end - loopB) < 0.05) {
                partMatch = i;
                break;
            }
        }
        const wholeMatch = Math.abs(parent.start - loopA) < 0.05 && Math.abs(parent.end - loopB) < 0.05;
        if (wholeMatch && partMatch >= 0) {
            // A single-part section's part range coincides with the whole
            // section. Preserve the user's whole/part intent when this is the
            // already-active parent; otherwise default to whole-section.
            if (parentIdx === _sectionPracticeActiveParent && !_sectionPracticeWholeSection) {
                return { parentIdx, whole: false, index: partMatch };
            }
            return { parentIdx, whole: true };
        }
        if (wholeMatch) return { parentIdx, whole: true };
        if (partMatch >= 0) return { parentIdx, whole: false, index: partMatch };
    }
    return null;
}

function _blurSectionPracticeFocusIfNeeded() {
    const ae = document.activeElement;
    const bar = document.getElementById('section-practice-bar');
    if (ae && bar && bar.contains(ae) && typeof ae.blur === 'function') {
        ae.blur();
    }
}

async function practiceSection(index, opts = {}) {
    const requestGen = ++_sectionPracticeRequestGen;
    const seekGen = _audioSeekGen;
    const loopGen = _loopMutationGen;
    const whole = !!opts.whole;
    const r = _sectionPracticeResolveLoopTarget(index, opts);
    if (!r) return;
    const dur = _sectionPracticeDuration();
    const start = Number(r.start);
    let end = Number(r.end);
    if (dur && Number.isFinite(dur) && end > dur) end = dur;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;

    // Mark the request in-flight so a bar re-render that fires during the awaited
    // setLoop below doesn't reconcile section state against the old/half-applied
    // loop. Cleared in finally so every exit path (bail, success, failure) resets.
    _sectionPracticeRequestInFlight++;
    try {
    _cancelCountIn();
    _setSectionPracticeMode(true, { skipClearLoop: true });

    // setLoop() is seek-gated: it returns false when the seek is cancelled
    // during arrangement switches / teardown-gen bumps, or when the backend
    // clock clamps off-target. Retry briefly to land after the transport
    // becomes ready without forking the loop system.
    let ok = false;
    for (let attempt = 0; attempt < 5; attempt++) {
        // A newer click or a song/arrangement change supersedes this retry.
        if (requestGen !== _sectionPracticeRequestGen || seekGen !== _audioSeekGen || loopGen !== _loopMutationGen) return;
        try {
            // skipSectionSync: this function owns the section-practice state and
            // applies it below under the request-gen guard, so a stale retry
            // landing here can't re-sync/re-arm via setLoop's shared path.
            // commitGuard: also prevent a superseded retry from committing
            // loopA/loopB at all — setLoop re-checks this right before arming,
            // after its internal seek await, so a stale loop is never armed.
            ok = await setLoop(start, end, {
                skipSectionSync: true,
                commitGuard: () => requestGen === _sectionPracticeRequestGen && seekGen === _audioSeekGen && loopGen === _loopMutationGen,
            });
        } catch (err) {
            ok = false;
        }
        if (ok) break;
        await new Promise(res => setTimeout(res, 60 + attempt * 90));
    }
    // Re-check after the awaited retries before applying any loop/count-in state.
    if (requestGen !== _sectionPracticeRequestGen || seekGen !== _audioSeekGen || loopGen !== _loopMutationGen) return;

    if (ok) {
        _sectionPracticeWholeSection = whole;
        if (!whole) {
            _sectionPracticeSelected = index;
            _sectionPracticeSavedPartIndex = index;
        }
        _blurSectionPracticeFocusIfNeeded();
        _updateSectionPracticeHighlight(_audioTime());
        startCountIn({ immediate: true });
    } else {
        _setSectionPracticeMode(false, { skipClearLoop: true });
    }
    } finally {
        _sectionPracticeRequestInFlight--;
    }
}

function _syncSectionPracticeFromLoop() {
    // A practiceSection() request owns the section state while it awaits its
    // loop; reconciling here against the prior/half-applied loop would fight it
    // (snapping the active parent back or toggling the mode off mid-request).
    if (_sectionPracticeRequestInFlight > 0) return;
    if (!_buildSectionParents().length) return;
    const match = _sectionPracticeLoopMatch();
    if (match) {
        // The loop may belong to a parent that isn't currently active (e.g.
        // restored from Saved Loops); switch to it and rebuild its parts so
        // the part-level UI reflects the matched section.
        if (match.parentIdx !== _sectionPracticeActiveParent) {
            _sectionPracticeActiveParent = match.parentIdx;
            _sectionPracticeRanges = _buildSectionPracticeRanges();
        }
        _sectionPracticeWholeSection = match.whole;
        if (!match.whole) {
            _sectionPracticeSelected = match.index;
            _sectionPracticeSavedPartIndex = match.index;
        } else {
            _sectionPracticeSelected = -1;
        }
    } else {
        _sectionPracticeWholeSection = false;
        _sectionPracticeSelected = -1;
    }
    if (loopA !== null && loopB !== null) {
        if (match) {
            if (!_sectionPracticeMode) {
                _setSectionPracticeMode(true, { skipClearLoop: true });
            }
        } else if (_sectionPracticeMode) {
            _setSectionPracticeMode(false, { skipClearLoop: true });
        }
    } else if (_sectionPracticeMode) {
        _setSectionPracticeMode(false, { skipClearLoop: true });
    }
    _updateSectionPracticeHighlight(_audioTime());
}

function _sectionPracticeIndexAtTime(t) {
    if (!Number.isFinite(t) || _sectionPracticeRanges.length === 0) return -1;
    for (let i = _sectionPracticeRanges.length - 1; i >= 0; i--) {
        if (t >= _sectionPracticeRanges[i].start) return i;
    }
    return -1;
}

function _sectionPracticeParentIndexAtTime(t) {
    const parents = _buildSectionParents();
    if (!Number.isFinite(t) || parents.length === 0) return -1;
    for (let i = parents.length - 1; i >= 0; i--) {
        if (t >= parents[i].start) return i;
    }
    return -1;
}

function _scrollSectionPracticeChipIntoView(chip) {
    if (!chip) return;
    chip.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function _updateSectionPracticeHighlight(ct) {
    const scroll = document.getElementById('section-practice-scroll');
    if (!scroll) return;
    const chips = scroll.querySelectorAll('.section-practice-chip[data-parent-idx]');
    if (!chips.length) return;

    const followEnabled = !_sectionPracticeMode && _sectionPracticeBarIsReady();
    const followParent = followEnabled ? _sectionPracticeParentIndexAtTime(ct) : -1;

    chips.forEach((chip) => {
        const idx = Number(chip.dataset.parentIdx);
        chip.classList.toggle('is-selected', idx === _sectionPracticeActiveParent);
        chip.classList.toggle('is-playing', followEnabled && idx === followParent);
    });

    if (followEnabled && followParent >= 0 && followParent !== _sectionPracticeFollowParent) {
        _sectionPracticeFollowParent = followParent;
        const chip = scroll.querySelector(`.section-practice-chip[data-parent-idx="${followParent}"]`);
        _scrollSectionPracticeChipIntoView(chip);
    } else if (!followEnabled) {
        _sectionPracticeFollowParent = -1;
    }

    _syncSectionPracticePieceUi();
}

function _maybeRefreshSectionPracticeDuration(dur) {
    if (_sectionPracticeDurSynced || !dur || _sectionPracticeRanges.length === 0) return;
    const rebuilt = _buildSectionPracticeRanges();
    if (!rebuilt.length) return;
    const prevEnd = _sectionPracticeRanges[_sectionPracticeRanges.length - 1].end;
    const nextEnd = rebuilt[rebuilt.length - 1].end;
    if (Math.abs(prevEnd - nextEnd) > 0.05) {
        _sectionPracticeDurSynced = true;
        renderSectionPracticeBar();
    } else {
        _sectionPracticeDurSynced = true;
    }
}

// Re-render when section metadata appears (before audio duration is known).
function _ensureSectionPracticeBar() {
    if (_sectionPracticeSourceSections().length === 0) return;
    if (!_sectionPracticeBarIsReady()) {
        renderSectionPracticeBar();
    }
}


async function loadSavedLoops() {
    const sel = document.getElementById('saved-loops');
    const delBtn = document.getElementById('btn-loop-delete');
    if (!currentFilename) { sel.classList.add('hidden'); delBtn.classList.add('hidden'); return; }

    const resp = await fetch(`/api/loops?filename=${encodeURIComponent(decodeURIComponent(currentFilename))}`);
    const loops = await resp.json();

    sel.innerHTML = '<option value="">Saved Loops</option>';
    for (const l of loops) {
        sel.innerHTML += `<option value="${l.id}" data-start="${l.start}" data-end="${l.end}">${esc(l.name)} (${formatTime(l.start)}→${formatTime(l.end)})</option>`;
    }
    if (loops.length > 0) {
        sel.classList.remove('hidden');
    } else {
        sel.classList.add('hidden');
    }
    delBtn.classList.add('hidden');
}

async function loadSavedLoop(loopId) {
    const sel = document.getElementById('saved-loops');
    const opt = sel.selectedOptions[0];
    const delBtn = document.getElementById('btn-loop-delete');
    if (!loopId || !opt?.dataset.start) {
        delBtn.classList.add('hidden');
        return;
    }
    let ok = false;
    try {
        // Pass raw strings — setLoop's Number() coercion is stricter than
        // parseFloat (rejects "12abc") so malformed dataset values throw
        // and fall into the catch instead of silently truncating.
        ok = await setLoop(opt.dataset.start, opt.dataset.end);
    } catch (err) {
        // Malformed dataset (server returned bad data): treat the same as
        // a failed seek so the dropdown resyncs and we don't propagate an
        // uncaught rejection out of the onchange handler.
        console.warn('[loadSavedLoop] setLoop threw:', err);
        ok = false;
    }
    if (!ok) {
        // Seek aborted, landed off-target, or input was malformed.
        // Resync the dropdown with the still-active loop so the UI
        // doesn't lie about which loop is loaded.
        _syncSavedLoopSelection();
        return;
    }
    // Success path: setLoop already called _syncSavedLoopSelection,
    // which surfaces the delete button when the new loop matches a
    // saved option (which the dropdown selection guarantees here).
}

// In-app text prompt — replaces window.prompt(), which Electron does NOT
// implement (it logs "prompt() is and will not be supported" and returns null),
// so any prompt()-based flow is a silent no-op on desktop. Returns the entered
// string, or null if cancelled (Esc / Cancel / backdrop). Styled to match the
// edit modal; role=dialog so the global keyboard shortcuts ignore typing here.
// Injection-safe: all caller text is set via textContent / value, never innerHTML.
function uiPrompt({ title = '', label = '', value = '', okLabel = 'Save', placeholder = '' } = {}) {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.className = 'feedBack-modal fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        if (title) modal.setAttribute('aria-label', title);
        modal.innerHTML = `
            <form class="bg-dark-700 border border-gray-700 rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl">
                <h3 class="text-lg font-bold text-white mb-4" data-ui-prompt-title hidden></h3>
                <label class="text-xs text-gray-400 mb-1 block" data-ui-prompt-label hidden></label>
                <input type="text" data-ui-prompt-input autocomplete="off"
                    class="w-full bg-dark-600 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-accent/50">
                <div class="flex gap-3 mt-5">
                    <button type="submit"
                        class="flex-1 bg-accent hover:bg-accent-light px-4 py-2 rounded-xl text-sm font-semibold text-white transition" data-ui-prompt-ok></button>
                    <button type="button" data-ui-prompt-cancel
                        class="px-4 py-2 bg-dark-600 hover:bg-dark-500 rounded-xl text-sm text-gray-300 transition">Cancel</button>
                </div>
            </form>`;
        const titleEl = modal.querySelector('[data-ui-prompt-title]');
        const labelEl = modal.querySelector('[data-ui-prompt-label]');
        const input = modal.querySelector('[data-ui-prompt-input]');
        const okEl = modal.querySelector('[data-ui-prompt-ok]');
        if (title) { titleEl.textContent = title; titleEl.hidden = false; }
        if (label) { labelEl.textContent = label; labelEl.hidden = false; }
        okEl.textContent = okLabel;
        input.value = value;
        if (placeholder) input.placeholder = placeholder;

        // Restore focus to wherever it was when we're done (matches the edit
        // modal's behavior so keyboard users aren't dumped at the page top).
        const previousActiveElement = document.activeElement;
        const focusables = () => Array.from(
            modal.querySelectorAll('input, button, [tabindex]:not([tabindex="-1"])'),
        ).filter((el) => !el.disabled && el.offsetParent !== null);

        let settled = false;
        const close = (result) => {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKey, true);
            modal.remove();
            if (previousActiveElement && typeof previousActiveElement.focus === 'function') {
                previousActiveElement.focus();
            }
            resolve(result);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); return; }
            // Trap Tab inside the modal so focus can't wander to the page behind it.
            if (e.key === 'Tab') {
                const items = focusables();
                if (!items.length) return;
                const first = items[0];
                const last = items[items.length - 1];
                const active = document.activeElement;
                if (e.shiftKey && (active === first || !modal.contains(active))) {
                    e.preventDefault(); last.focus();
                } else if (!e.shiftKey && (active === last || !modal.contains(active))) {
                    e.preventDefault(); first.focus();
                }
            }
        };
        modal.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); close(input.value); });
        modal.querySelector('[data-ui-prompt-cancel]').addEventListener('click', () => close(null));
        // Backdrop (overlay itself, not the panel) cancels.
        modal.addEventListener('mousedown', (e) => { if (e.target === modal) close(null); });
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(modal);
        input.focus();
        input.select();
    });
}

async function saveCurrentLoop() {
    if (loopA === null || loopB === null || !currentFilename) return;
    const name = await uiPrompt({ title: 'Save Loop', label: 'Loop name', value: 'Loop', okLabel: 'Save' });
    if (name === null) return;          // cancelled
    const finalName = name.trim() || 'Loop';   // never persist an empty name
    await fetch('/api/loops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            filename: decodeURIComponent(currentFilename),
            name: finalName,
            start: loopA,
            end: loopB,
        }),
    });
    await loadSavedLoops();
    document.getElementById('btn-loop-save').classList.add('hidden');
}

async function deleteSelectedLoop() {
    const sel = document.getElementById('saved-loops');
    const loopId = sel.value;
    if (!loopId) return;
    await fetch(`/api/loops/${loopId}`, { method: 'DELETE' });
    clearLoop();
    await loadSavedLoops();
}

// ── Count-in click sound (Web Audio API) ────────────────────────────────
let _audioCtx = null;
function playClick(high = false) {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = _audioCtx.createOscillator();
    const gain = _audioCtx.createGain();
    osc.connect(gain);
    gain.connect(_audioCtx.destination);
    osc.frequency.value = high ? 1200 : 800;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.5, _audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, _audioCtx.currentTime + 0.08);
    osc.start(_audioCtx.currentTime);
    osc.stop(_audioCtx.currentTime + 0.08);
}

let _countingIn = false;
let _countOverlay = null;
// Generation token so teardown can cancel an in-progress count-in. Each
// startCountIn() captures the gen at entry; rewindStep, the loop-wrap
// then-callback, and beginCount's tick all bail when their captured gen
// no longer matches. Bumped by _cancelCountIn().
let _countInGen = 0;
let _countInTimer = null;
let _countInRaf = 0;
// Feedpak credits overlay (manifest `authors:`, spec §5.4): shown on the
// highway when a song is loaded, alongside the count-in. Torn down together
// with the count-in via _cancelCountIn().
let _creditsOverlay = null;
let _creditsTimer = null;
let _creditsHideOnPlay = null;
let _creditsMaxTimer = null;
const _CREDITS_HOLD_MS = 3000;
// Backstop: the overlay's primary dismiss is song:play, but playback can fail
// to start without emitting it (HTML5 autoplay rejection, JUCE start failure,
// a count-in handoff that never plays). This hard cap guarantees the credits
// never linger over the highway. Generous enough to outlast a normal count-in.
const _CREDITS_MAX_MS = 12000;
function _cancelCountIn() {
    _countInGen++;
    _countingIn = false;
    hideCountOverlay();
    // The credits overlay rides the count-in lifecycle (and its no-count-in
    // hold timer), so a teardown — leaving the player, loading another song —
    // must clear it too, or it lingers on the next screen.
    hideSongCreditsOverlay();
    if (_countInTimer) { clearTimeout(_countInTimer); _countInTimer = null; }
    if (_countInRaf) { cancelAnimationFrame(_countInRaf); _countInRaf = 0; }
}

function showCountOverlay(n) {
    if (!_countOverlay) {
        _countOverlay = document.createElement('div');
        _countOverlay.className = 'fixed inset-0 z-[100] flex items-center justify-center pointer-events-none';
        document.body.appendChild(_countOverlay);
    }
    _countOverlay.innerHTML = `<span class="text-9xl font-black text-white/30">${n}</span>`;
}

function hideCountOverlay() {
    if (_countOverlay) { _countOverlay.remove(); _countOverlay = null; }
}

// Map a feedpak author `role` to a friendly "<verb> by" credit line. The
// recommended vocabulary is from feedpak spec §5.4; unknown roles are
// title-cased ("foo" → "Foo by"); a missing role shows the bare name.
const _CREDIT_ROLE_VERBS = {
    charter: 'Charted by',
    transcriber: 'Transcribed by',
    arranger: 'Arranged by',
    editor: 'Edited by',
    mixer: 'Mixed by',
    engineer: 'Engineered by',
    proofreader: 'Proofread by',
};

function _creditLineLabel(role) {
    if (!role) return '';
    const key = String(role).trim().toLowerCase();
    if (_CREDIT_ROLE_VERBS[key]) return _CREDIT_ROLE_VERBS[key];
    return key.charAt(0).toUpperCase() + key.slice(1) + ' by';
}

// Show the feedpak contributor credits over the highway. `authors` is the
// sanitized [{name, role}] list from window.feedBack.currentSong.authors.
// Anchored to the lower third (bottom-center) so it never collides with the
// vertically-centered count-in number, and pointer-events-none so it never
// intercepts clicks. No-op when there are no contributors to show.
function showSongCreditsOverlay(authors) {
    if (!Array.isArray(authors) || authors.length === 0) return;
    if (!_creditsOverlay) {
        _creditsOverlay = document.createElement('div');
        _creditsOverlay.className = 'song-credits-overlay';
        document.body.appendChild(_creditsOverlay);
    }
    // Build via DOM + textContent — author names are untrusted pack data and
    // must never be interpolated as HTML.
    _creditsOverlay.replaceChildren();
    const card = document.createElement('div');
    card.className = 'song-credits-card';

    const eyebrow = document.createElement('div');
    eyebrow.className = 'song-credits-eyebrow';
    eyebrow.textContent = 'Credits';
    card.appendChild(eyebrow);

    const title = (window.feedBack && window.feedBack.currentSong
        && window.feedBack.currentSong.title) || '';
    if (title) {
        const heading = document.createElement('div');
        heading.className = 'song-credits-heading';
        heading.textContent = title;
        card.appendChild(heading);
    }

    for (const a of authors) {
        if (!a || !a.name) continue;
        const row = document.createElement('div');
        row.className = 'song-credits-line';
        const label = _creditLineLabel(a.role);
        if (label) {
            const lab = document.createElement('span');
            lab.className = 'song-credits-role';
            lab.textContent = label + ' ';
            row.appendChild(lab);
        }
        const nm = document.createElement('span');
        nm.className = 'song-credits-name';
        nm.textContent = a.name;
        row.appendChild(nm);
        card.appendChild(row);
    }
    _creditsOverlay.appendChild(card);
    // Arm the backstop so the overlay self-clears even if playback never starts
    // / never emits song:play. song:play (or any teardown) clears it earlier.
    if (_creditsMaxTimer) clearTimeout(_creditsMaxTimer);
    _creditsMaxTimer = setTimeout(hideSongCreditsOverlay, _CREDITS_MAX_MS);
}

function hideSongCreditsOverlay() {
    if (_creditsTimer) { clearTimeout(_creditsTimer); _creditsTimer = null; }
    if (_creditsMaxTimer) { clearTimeout(_creditsMaxTimer); _creditsMaxTimer = null; }
    if (_creditsHideOnPlay) {
        window.feedBack.off('song:play', _creditsHideOnPlay);
        _creditsHideOnPlay = null;
    }
    if (_creditsOverlay) { _creditsOverlay.remove(); _creditsOverlay = null; }
}

async function startCountIn(opts = {}) {
    if (_countingIn) return;
    _countingIn = true;
    // Snapshot the current gen so every delayed callback (rewind frames,
    // post-seek then, count-in ticks, post-count play) can bail if a
    // teardown bumped the gen mid-flight via _cancelCountIn().
    const gen = _countInGen;
    const immediate = !!opts.immediate;
    if (window._juceMode) {
        await jucePlayer.pause().catch((err) => console.error('[app] jucePlayer.pause error in count-in:', err));
    } else {
        audio.pause();
    }
    if (gen !== _countInGen) return; // teardown during pause

    // Section-practice entry: already at loop A after setLoop(); skip the
    // B→A rewind animation used on loop wrap and go straight to clicks.
    if (immediate) {
        if (loopA === null || loopB === null) {
            _countingIn = false;
            return;
        }
        lastAudioTime = loopA;
        highway.setTime(loopA);
        if (window.feedBack) {
            window.feedBack.emit('loop:restart', { loopA, loopB, time: loopA });
        }
        beginCount();
        return;
    }

    // Rewind animation: sweep highway time from B to A
    const rewindDuration = 400; // ms
    const rewindStart = performance.now();
    const fromTime = loopB;
    const toTime = loopA;

    function rewindStep(now) {
        if (gen !== _countInGen) return; // teardown mid-rewind
        const elapsed = now - rewindStart;
        const t = Math.min(elapsed / rewindDuration, 1);
        // Ease out quad
        const eased = 1 - (1 - t) * (1 - t);
        const currentT = fromTime + (toTime - fromTime) * eased;
        highway.setTime(currentT);
        if (t < 1) {
            _countInRaf = requestAnimationFrame(rewindStep);
        } else {
            _countInRaf = 0;
            // Rewind done — set final position and start count.
            // Await the JUCE seek so the engine has repositioned before
            // we start the click track (HTML5 path is synchronous).
            _audioSeek(loopA, 'loop-wrap').then((r) => {
                if (gen !== _countInGen) return; // teardown during seek
                // Abort the loop restart in two cases:
                //   1. Cancelled (player torn down): don't beginCount on a
                //      new session.
                //   2. Off-target landing (JUCE rollback / clamp far from
                //      loopA): proceeding would emit loop:restart and start
                //      a count-in from the wrong position. Audio is at
                //      r.from / r.to, which is not where the loop wants to
                //      resume — better to drop this iteration than play out
                //      of sync.
                // 50 ms tolerance: well within JUCE's normal seek precision
                // but tight enough to catch a real rollback or no-op.
                if (!r.completed || Math.abs(r.to - loopA) > 0.05) {
                    // startCountIn paused audio at entry but left isPlaying
                    // alone — beginCount would have set it on resume. On
                    // abort, sync the transport: audio is paused, so
                    // isPlaying must reflect that and the button + plugin
                    // host must agree.
                    _countingIn = false;
                    if (isPlaying) {
                        isPlaying = false;
                        setPlayButtonState(false);
                        if (window.feedBack) {
                            window.feedBack.isPlaying = false;
                            window.feedBack.emit('song:pause', _songEventPayload());
                        }
                    }
                    return;
                }
                // Use the verified post-seek clock for the chart so audio
                // and chart stay in sync if JUCE clamped to slightly
                // before/after loopA. The loop:restart event keeps `time:
                // loopA` because subscribers treat that as the semantic
                // marker for "new iteration starts at A", not the actual
                // audio position.
                lastAudioTime = r.to;
                highway.setTime(r.to);
                window.feedBack.emit('loop:restart', { loopA, loopB, time: loopA });
                beginCount();
            });
        }
    }
    _countInRaf = requestAnimationFrame(rewindStep);

    function beginCount() {
        const bpm = highway.getBPM(loopA);
        const beatInterval = 60 / bpm;
        let count = 0;

        function tick() {
            if (gen !== _countInGen) return; // teardown mid-count
            count++;
            if (count > 4) {
                hideCountOverlay();
                _countingIn = false;
                if (window._juceMode) {
                    jucePlayer.play().then((started) => {
                        if (gen !== _countInGen) return; // teardown during play start
                        if (!started) return;
                        isPlaying = true;
                        setPlayButtonState(true);
                        window.feedBack.isPlaying = true;
                        const payload = _songEventPayload();
                        window.feedBack.emit('song:play', payload);
                        window.feedBack.emit('song:resume', payload);
                    }).catch((err) => console.error('[app] jucePlayer.play error:', err));
                } else {
                    audio.play().then(() => {
                        if (gen !== _countInGen) return;
                        isPlaying = true;
                        setPlayButtonState(true);
                    }).catch((err) => {
                        if (gen !== _countInGen) return;
                        // An engine reroute's deliberate pause aborts this play()
                        // while playback continues on JUCE — don't reset the
                        // button (mirrors the togglePlay guard).
                        if (window._juceRerouteInProgress) return;
                        // Same rationale as togglePlay: don't claim playback
                        // started if the Promise rejected.
                        console.error('[app] audio.play() rejected after count-in:', err);
                        isPlaying = false;
                        setPlayButtonState(false);
                    });
                }
                return;
            }
            showCountOverlay(count);
            playClick(count === 1);
            _countInTimer = setTimeout(tick, beatInterval * 1000);
        }
        _countInTimer = setTimeout(tick, 500);
    }
}

// Start-of-song count-in: a 4-beat click before playback begins, gated by the
// "Countdown before song" setting (Gameplay tab). Mirrors the loop count-in's
// overlay + click + gen-token cancellation, but counts from the song's current
// position (0 at song start) with no loop A/B rewind. startCountIn() is loop-
// coupled (early-returns when loopA/loopB are null), so this is a sibling
// rather than an overload. Hands off to togglePlay() once the count completes.
async function startSongCountIn() {
    if (_countingIn) return;
    _countingIn = true;
    // Snapshot the gen so a teardown (showScreen/playSong calls _cancelCountIn)
    // bumps it and every delayed callback below bails.
    const gen = _countInGen;
    if (window._juceMode) {
        await jucePlayer.pause().catch((err) => console.error('[app] jucePlayer.pause error in song count-in:', err));
    } else {
        audio.pause();
    }
    if (gen !== _countInGen) return; // teardown during pause
    const startT = lastAudioTime || 0;
    let bpm = highway.getBPM(startT);
    // Pre-chart / malformed-tempo fallback: 4 beats at 120 BPM (500 ms each).
    if (!Number.isFinite(bpm) || bpm <= 0) bpm = 120;
    const beatInterval = 60 / bpm;
    let count = 0;
    function tick() {
        if (gen !== _countInGen) return; // teardown mid-count
        count++;
        if (count > 4) {
            hideCountOverlay();
            _countingIn = false;
            // Hand off to the normal play path — togglePlay() flips isPlaying,
            // updates the button, and emits song:play/resume for plugins.
            Promise.resolve(togglePlay()).catch((err) => console.warn('[app] play after count-in failed:', err));
            return;
        }
        showCountOverlay(count);
        playClick(count === 1);
        _countInTimer = setTimeout(tick, beatInterval * 1000);
    }
    // First beat after a short lead-in, matching the loop count-in's 500 ms.
    _countInTimer = setTimeout(tick, 500);
}

// Time display + highway sync
let lastAudioTime = 0;
// hud-time write cache: the 60 Hz tick below used to rewrite textContent
// (and getElementById) every tick even though the mm:ss display only
// changes once a second — each write invalidates layout. Write-on-change
// with a cached element ref (re-resolved if detached).
let _hudTimeEl = null;
let _hudTimeLast = '';
setInterval(() => {
    let ct = _audioTime();
    const dur = _audioDuration();
    if (dur && !_countingIn) {
        // JUCE end-of-track: HTML5 fires 'ended'; JUCE needs a manual check
        if (window._juceMode && isPlaying && ct >= dur) {
            isPlaying = false;
            setPlayButtonState(false);
            window.feedBack.isPlaying = false;
            window.feedBack.emit('song:ended', _songEventPayload());
            jucePlayer.pause().catch((err) => console.warn('[app] end-of-track pause error:', err));
        }
        // A-B loop: count-in then seek back to A
        else if (loopA !== null && loopB !== null && ct >= loopB) {
            lastAudioTime = loopB;
            startCountIn();
        }
        // Detect and fix audio time jumps (browser seeking bug; skip for JUCE — position is polled)
        else if (!window._juceMode && isPlaying && Math.abs(ct - lastAudioTime) > 30 && lastAudioTime > 0) {
            console.warn(`Audio time jumped from ${lastAudioTime.toFixed(1)} to ${ct.toFixed(1)}, resetting`);
            _audioSeek(lastAudioTime, 'jump-fix');
            // Treat the corrected position as canonical for the rest of this
            // tick. Otherwise we'd write the stale jumped `ct` into
            // lastAudioTime below and ping-pong on the next tick.
            ct = lastAudioTime;
        }
        lastAudioTime = ct;
        const hudText = `${formatTime(ct)} / ${formatTime(dur)}`;
        if (hudText !== _hudTimeLast) {
            if (!_hudTimeEl || !_hudTimeEl.isConnected) _hudTimeEl = document.getElementById('hud-time');
            if (_hudTimeEl) _hudTimeEl.textContent = hudText;
            _hudTimeLast = hudText;
        }
        if (dur) {
            _maybeRefreshSectionPracticeDuration(dur);
        }
    }
    _ensureSectionPracticeBar();
    if (_sectionPracticeBarIsReady() && _sectionPracticeSourceSections().length) {
        _updateSectionPracticeHighlight(ct);
    }
    if (!_countingIn) highway.setTime(ct);
}, 1000 / 60);

_installSectionPracticeDrawHook();

// ── Centralized Keyboard Shortcut Registry ───────────────────────────────
//
// Plugins can register keyboard shortcuts via window.registerShortcut().
// Shortcuts are scope-aware (global, player, library, plugin-specific) and
// support optional condition callbacks for dynamic enable/disable.
//
// Panel-scoped shortcuts:
//   - Each panel has its own shortcut registry
//   - Use window.createShortcutPanel(id) to create a panel
//   - Use window.setActiveShortcutPanel(id) to set the active panel
//   - Shortcuts are registered to the active panel
//   - This allows multiple panels (e.g., splitscreen) to have their own shortcuts
//
// API:
//   window.registerShortcut({
//     key: string,              // Required: key value (e.key) or key code (e.code)
//     description: string,     // Required: shown in help panel
//     scope: 'global' | 'player' | 'library' | 'settings' | 'plugin-{id}',  // Default: 'global'
//     condition: () => boolean,  // Optional: dynamic enable/disable guard
//     handler: (e) => void,    // Required: callback when shortcut triggers
//     modifiers: {              // Optional: require modifier keys
//       ctrl?: boolean,
//       alt?: boolean,
//       shift?: boolean,
//       meta?: boolean
//     }
//   });
//
// Panel API:
//   window.createShortcutPanel(id) - Create a new panel
//   window.setActiveShortcutPanel(id) - Set the active panel for registration
//   window.getActiveShortcutPanel() - Get the current active panel
//   window.isInShortcutPanel() - Check if running in a panel (not default)
//   window.getGlobalShortcutContext() - Get default panel for truly global shortcuts
//
// Note: The handler receives the KeyboardEvent, so you can check
// e.shiftKey, e.altKey, etc. directly in your handler if you need
// behavior that depends on modifier state (e.g., different actions
// for Shift+key vs key alone). Use the modifiers option when you
// want the shortcut to ONLY fire with specific modifiers.
//
// See CLAUDE.md for full documentation.

// ── Window ID system for per-window shortcuts ────────────────────────────────
// Each window gets a unique ID so plugins can register window-specific shortcuts.
// This is useful for popup windows (e.g., splitscreen plugin) that need their
// own keyboard shortcuts.

let _shortcutWindowId = null;

window.getShortcutWindowId = () => {
    if (_shortcutWindowId) return _shortcutWindowId;
    // Generate a unique ID for this window
    _shortcutWindowId = 'win-' + Math.random().toString(36).substr(2, 9);
    return _shortcutWindowId;
};

// ── Shortcut registry ───────────────────────────────────────────────────────

// ── Panel-scoped shortcut system ───────────────────────────────────────────
// Each panel has its own shortcut registry. This allows multiple panels
// (e.g., splitscreen) to have their own keyboard shortcuts without collisions.

class ShortcutPanel {
    constructor(id) {
        this.id = id;
        this.shortcuts = new Map();
    }
    
    _compositeKey(key, scope) {
        return `${scope}::${key}`;
    }
    
    registerShortcut(options) {
        const { key, description, scope = 'global', condition = null, handler, modifiers = null } = options;
        
        if (!key || !handler) {
            console.error(`registerShortcut: key and handler are required`);
            return;
        }
        
        // Validate scope
        const validScopes = ['global', 'player', 'library', 'settings'];
        const isValidScope = validScopes.includes(scope) || 
                             scope.startsWith('plugin-');
        if (!isValidScope) {
            console.warn(`registerShortcut: invalid scope '${scope}'. Valid scopes are: global, player, library, settings, or plugin-{id}`);
        }
        
        // Conflict detection: warn if key+scope is already registered
        const compositeKey = this._compositeKey(key, scope);
        if (this.shortcuts.has(compositeKey)) {
            console.warn(`registerShortcut [${this.id}]: '${key}' in scope '${scope}' is already registered; overwriting. Previous:`, this.shortcuts.get(compositeKey));
        }
        
        this.shortcuts.set(compositeKey, { key, description, scope, condition, handler, modifiers });
    }
    
    unregisterShortcut(key, scope) {
        return this.shortcuts.delete(this._compositeKey(key, scope));
    }
    
    clearShortcuts() {
        this.shortcuts.clear();
    }
    
    listShortcuts() {
        return Array.from(this.shortcuts.entries()).map(([ck, s]) => [s.key, s]);
    }
}

// Global panel management
const _panels = new Map();
let _activePanel = null;
let _defaultPanel = null;

// Create default panel on init
const defaultPanel = new ShortcutPanel('default');
_panels.set('default', defaultPanel);
_defaultPanel = 'default';
_activePanel = 'default';

// ── Panel API ───────────────────────────────────────────────────────────────

window.createShortcutPanel = (id) => {
    if (_panels.has(id)) {
        console.warn(`createShortcutPanel: panel '${id}' already exists`);
        return _panels.get(id);
    }
    const panel = new ShortcutPanel(id);
    _panels.set(id, panel);
    return panel;
};

window.setActiveShortcutPanel = (id) => {
    if (!_panels.has(id)) {
        console.error(`setActiveShortcutPanel: panel '${id}' does not exist`);
        return;
    }
    _activePanel = id;
};

window.getActiveShortcutPanel = () => _activePanel;

window.isInShortcutPanel = () => {
    return _activePanel !== 'default';
};

window.getGlobalShortcutContext = () => {
    console.warn('getGlobalShortcutContext: Global shortcuts are exceptional. Consider using panel-scoped shortcuts instead.');
    return _panels.get('default');
};

// ── Shortcut registry (routes to active panel) ───────────────────────────────

window.registerShortcut = (options) => {
    const panelId = _activePanel || _defaultPanel || 'default';
    const panel = _panels.get(panelId);
    
    if (!panel) {
        console.error(`registerShortcut: No panel found for registration: ${panelId}`);
        return;
    }
    
    panel.registerShortcut(options);
};

// Flat, read-only snapshot of every registered shortcut across all panels,
// for the Settings → Keybinds reference tab. Dedupes by combo+scope (the same
// shortcut can live in both the active panel and the default panel) and uses
// the same modifier-prefix formatting as the shortcuts modal. Returns
// [{ combo, description, scope }]; remapping is not supported, so this is
// purely informational.
window.getAllShortcuts = () => {
    const fmt = (s) => {
        const m = s.modifiers || {};
        return (m.ctrl ? 'Ctrl+' : '') + (m.alt ? 'Alt+' : '')
            + (m.shift ? 'Shift+' : '') + (m.meta ? 'Meta+' : '') + s.key;
    };
    const seen = new Set();
    const out = [];
    for (const [, panel] of _panels) {
        if (!panel || !panel.shortcuts) continue;
        for (const [, s] of panel.shortcuts) {
            const combo = fmt(s);
            const dedupe = combo + '|' + (s.scope || '');
            if (seen.has(dedupe)) continue;
            seen.add(dedupe);
            out.push({ combo, description: s.description || '', scope: s.scope || 'global' });
        }
    }
    return out;
};

window.unregisterShortcut = (key, scope) => {
    // Try the active panel first to preserve panel isolation; fall back to
    // other panels so a shortcut registered before a panel switch is still
    // removable.
    const resolvedScope = scope || 'global';
    const activePanelId = _activePanel || _defaultPanel || 'default';
    const activePanel = _panels.get(activePanelId);
    if (activePanel && activePanel.unregisterShortcut(key, resolvedScope)) {
        return true;
    }
    for (const [panelId, panel] of _panels) {
        if (panelId === activePanelId) continue;
        if (panel.unregisterShortcut(key, resolvedScope)) {
            return true;
        }
    }
    return false;
};

window.clearWindowShortcuts = (windowId) => {
    // Remove all shortcuts registered for a specific window
    // This is for backward compatibility with window-specific shortcuts
    let removed = 0;
    for (const [panelId, panel] of _panels) {
        if (panelId.startsWith(`window-${windowId}`)) {
            panel.clearShortcuts();
            _panels.delete(panelId);
            removed++;
        }
    }
    return removed;
};

function _getCurrentContext() {
    const currentScreen = document.querySelector('.screen.active')?.id;
    return {
        screen: currentScreen,
        windowId: window.getShortcutWindowId(),
        activePanel: _activePanel,
        isPlayer: currentScreen === 'player',
        isLibrary: ['home', 'favorites'].includes(currentScreen),
        isSettings: currentScreen === 'settings',
        isPlugin: currentScreen?.startsWith('plugin-')
    };
}

function _isShortcutActive(shortcut, ctx) {
    if (shortcut.scope === 'global') return true;
    if (shortcut.scope === 'player' && ctx.isPlayer) return true;
    if (shortcut.scope === 'library' && ctx.isLibrary) return true;
    if (shortcut.scope === 'settings' && ctx.isSettings) return true;
    if (shortcut.scope.startsWith('plugin-')) {
        const pluginId = shortcut.scope.replace('plugin-', '');
        return ctx.screen === `plugin-${pluginId}`;
    }
    return false;
}

function _modifiersMatch(e, modifiers) {
    if (!modifiers) return true;
    if (modifiers.ctrl !== undefined && modifiers.ctrl !== e.ctrlKey) return false;
    if (modifiers.alt !== undefined && modifiers.alt !== e.altKey) return false;
    if (modifiers.shift !== undefined && modifiers.shift !== e.shiftKey) return false;
    if (modifiers.meta !== undefined && modifiers.meta !== e.metaKey) return false;
    return true;
}

// Debug mode for keyboard shortcuts
let _DEBUG_SHORTCUTS = false;

window._setDebugShortcuts = (enabled) => {
    _DEBUG_SHORTCUTS = enabled;
    console.log(`[Shortcuts] Debug mode ${enabled ? 'ENABLED' : 'DISABLED'}`);
};

window._listShortcuts = () => {
    console.log('=== Registered Shortcuts ===');
    for (const [panelId, panel] of _panels) {
        console.log(`Panel: ${panelId}`);
        for (const [, s] of panel.shortcuts) {
            console.log(`  ${s.key.padEnd(15)} | ${s.scope.padEnd(10)} | ${s.description}`);
        }
    }
    console.log('=== End ===');
};

window._testShortcut = (key, scope) => {
    // Mirror the dispatcher: try the active panel first, then default.
    const resolvedScope = scope || 'global';
    const tried = new Set();
    const panelOrder = [_activePanel, _defaultPanel, 'default'].filter(id => {
        if (!id || tried.has(id)) return false;
        tried.add(id);
        return true;
    });

    for (const panelId of panelOrder) {
        const panel = _panels.get(panelId);
        if (!panel) continue;
        const shortcut = panel.shortcuts.get(panel._compositeKey(key, resolvedScope));
        if (!shortcut) continue;

        const ctx = _getCurrentContext();
        const active = _isShortcutActive(shortcut, ctx);
        let conditionMet = true;
        if (shortcut.condition) {
            try { conditionMet = !!shortcut.condition(); }
            catch (err) { conditionMet = `threw: ${err.message}`; }
        }
        console.log(`Shortcut '${key}' [${resolvedScope}] [${panelId}]:`, {
            description: shortcut.description,
            scope: shortcut.scope,
            currentContext: ctx,
            isActive: active,
            conditionMet
        });
        return;
    }

    console.log(`Shortcut '${key}' (scope: ${resolvedScope}) not registered in any panel`);
};

// Expose internals for debugging (prefixed with _ to indicate private)
// These are for development/debugging only and should not be used by plugins.
window._panels = _panels;
window._getCurrentContext = _getCurrentContext;
window._isShortcutActive = _isShortcutActive;

// ── Registry-based keydown handler ─────────────────────────────────────────
//
// This handler processes all registered shortcuts through the central registry.
// It runs after the library navigation handler (which handles /, ?, c, f, e, etc.)
// and before any other keydown listeners.

document.addEventListener('keydown', e => {
    if (_shortcutDispatchBlocked(e)) return;

    const ctx = _getCurrentContext();
    const activePanel = _panels.get(_activePanel);
    const defaultPanel = _panels.get('default');
    
    if (!activePanel && !defaultPanel) return;

    if (_DEBUG_SHORTCUTS) {
        console.log('[Shortcuts] Key pressed:', { key: e.key, code: e.code, ctx, activePanel: _activePanel });
    }

    // Try active panel first, then fall back to default
    const panelsToDispatch = [];
    if (activePanel && activePanel !== defaultPanel) panelsToDispatch.push(activePanel);
    if (defaultPanel) panelsToDispatch.push(defaultPanel);

    for (const panel of panelsToDispatch) {
        for (const [, shortcut] of panel.shortcuts) {
        // Match on both e.key (character produced) and e.code (physical key)
        if (e.key !== shortcut.key && e.code !== shortcut.key) continue;

        // Check modifier keys if specified
        if (!_modifiersMatch(e, shortcut.modifiers)) continue;

        if (_DEBUG_SHORTCUTS) {
            console.log('[Shortcuts] Matched shortcut:', shortcut.key, shortcut);
        }

        // Check scope
        if (!_isShortcutActive(shortcut, ctx)) {
            if (_DEBUG_SHORTCUTS) {
                console.log('[Shortcuts] Not active - scope mismatch:', shortcut.scope, ctx);
            }
            continue;
        }

        // Check condition callback — guard against plugin errors
        if (shortcut.condition) {
            try {
                if (!shortcut.condition()) {
                    if (_DEBUG_SHORTCUTS) {
                        console.log('[Shortcuts] Not active - condition failed');
                    }
                    continue;
                }
            } catch (err) {
                console.error('[Shortcuts] condition() threw for key:', shortcut.key, err);
                continue;
            }
        }

        e.preventDefault();
        if (_DEBUG_SHORTCUTS) {
            console.log('[Shortcuts] Executing handler for:', shortcut.key);
        }
        // Guard handler against plugin errors
        try {
            shortcut.handler(e);
        } catch (err) {
            console.error('[Shortcuts] handler() threw for key:', shortcut.key, err);
        }
        return;
    }
}

    if (_DEBUG_SHORTCUTS) {
        console.log('[Shortcuts] No shortcut matched for:', e.key, e.code);
    }
});

// ── Window cleanup ───────────────────────────────────────────────────────────
// Clean up window-specific shortcuts when a window is closed.
// This is important for popup windows (e.g., splitscreen plugin) that
// may be closed by the user.

window.addEventListener('beforeunload', () => {
    const windowId = window.getShortcutWindowId();
    const removed = window.clearWindowShortcuts(windowId);
    if (removed > 0 && _DEBUG_SHORTCUTS) {
        console.log(`[Shortcuts] Cleaned up ${removed} shortcuts for window ${windowId}`);
    }
});

// ── Register built-in shortcuts ───────────────────────────────────────────

// Global shortcuts
registerShortcut({
    key: '?',
    description: 'Show keyboard shortcuts',
    scope: 'global',
    handler: () => _openShortcutsModal()
});

// Library shortcuts
registerShortcut({
    key: '/',
    description: 'Focus search',
    scope: 'library',
    handler: () => {
        const input = _activeSearchInput();
        if (input) input.focus();
    }
});

registerShortcut({
    key: 'f',
    description: 'Toggle favorite',
    scope: 'library',
    handler: () => {
        // Handled by library navigation - this is for documentation only
    }
});

registerShortcut({
    key: 'e',
    description: 'Edit metadata',
    scope: 'library',
    handler: () => {
        // Handled by library navigation - this is for documentation only
    }
});

// Player shortcuts
registerShortcut({
    key: 'Space',
    description: 'Play/Pause',
    scope: 'player',
    handler: () => togglePlay()
});

registerShortcut({
    key: 'ArrowLeft',
    description: 'Seek back 5 seconds',
    scope: 'player',
    handler: () => seekBy(-5)
});

registerShortcut({
    key: 'ArrowRight',
    description: 'Seek forward 5 seconds',
    scope: 'player',
    handler: () => seekBy(5)
});

registerShortcut({
    key: 'Escape',
    description: 'Back to library',
    scope: 'player',
    handler: () => requestExitSong()
});

registerShortcut({
    key: 'Escape',
    description: 'Go back to previous screen',
    scope: 'settings',
    handler: () => showScreen(_settingsOriginScreen || 'home')
});

registerShortcut({
    key: '[',
    description: 'Offset audio back (Shift: 50ms, else 10ms)',
    scope: 'player',
    handler: (e) => nudgeAvOffsetMs(e.shiftKey ? -50 : -10)
});

registerShortcut({
    key: ']',
    description: 'Offset audio forward (Shift: 50ms, else 10ms)',
    scope: 'player',
    handler: (e) => nudgeAvOffsetMs(e.shiftKey ? 50 : 10)
});

registerShortcut({
    key: '+',
    description: 'Volume up',
    scope: 'player',
    modifiers: { ctrl: false, alt: false, meta: false },
    handler: () => _adjustSongVolume(1)
});

// Layout-portable alias — matches the physical "=/+" key (e.code === 'Equal')
// regardless of keyboard layout or shift state, so non-US layouts that
// don't map Shift+= to '+' still work.
registerShortcut({
    key: 'Equal',
    description: 'Volume up',
    scope: 'player',
    modifiers: { ctrl: false, alt: false, meta: false },
    handler: () => _adjustSongVolume(1)
});

registerShortcut({
    key: '-',
    description: 'Volume down',
    scope: 'player',
    modifiers: { ctrl: false, alt: false, meta: false },
    handler: () => _adjustSongVolume(-1)
});

registerShortcut({
    key: 'Minus',
    description: 'Volume down',
    scope: 'player',
    modifiers: { ctrl: false, alt: false, meta: false },
    handler: () => _adjustSongVolume(-1)
});

// ── Edit metadata modal ─────────────────────────────────────────────────
function openEditModal(songData, openerEl) {
    const artUrl = `/api/song/${encodeURIComponent(songData.f)}/art?t=${Date.now()}`;
    const modal = document.createElement('div');
    modal.id = 'edit-modal';
    modal.className = 'feedBack-modal fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm';
    // role=dialog: assistive tech announces it as a modal; also lets
    // the global keyboard listener's `_isInsideInteractiveControl`
    // bail when typing inside the modal so Library shortcuts don't
    // hijack keys from the edit form.
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Edit song metadata');
    // Record the element that triggered the modal so Esc / Cancel can
    // return focus to the exact entry the user was on, even if
    // _lastLibSelected changes before the modal closes.
    // Prefer the explicitly-passed openerEl (from the edit-btn click
    // handler, which has the exact [data-play] parent) over
    // _lastLibSelected, which may not have been updated when the
    // click's stopPropagation() prevented the card-click handler.
    const _emActive = document.querySelector('.screen.active');
    const _emLast = (_lastLibSelected && document.body.contains(_lastLibSelected)
        && _emActive && _emActive.contains(_lastLibSelected)) ? _lastLibSelected : null;
    modal._opener = (openerEl && document.body.contains(openerEl)) ? openerEl : _emLast;
    modal.innerHTML = `
        <div class="bg-dark-700 border border-gray-700 rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl">
            <h3 class="text-lg font-bold text-white mb-4">Edit Song</h3>
            <div class="space-y-3">
                <div class="flex items-center gap-4 mb-2">
                    <div class="relative group cursor-pointer" id="edit-art-wrapper">
                        <img src="${artUrl}" alt="" class="w-20 h-20 rounded-lg object-cover bg-dark-600" id="edit-art-preview">
                        <div class="absolute inset-0 bg-black/50 rounded-lg flex items-center justify-center opacity-0 group-hover:opacity-100 transition">
                            <span class="text-white text-xs">Change</span>
                        </div>
                        <input type="file" accept="image/*" id="edit-art-file" class="hidden" onchange="previewEditArt(this)">
                    </div>
                    <p class="text-xs text-gray-500 flex-1">Click image to change album art</p>
                </div>
                <div>
                    <label class="text-xs text-gray-400 mb-1 block">Title</label>
                    <input type="text" id="edit-title" value="${_escAttr(songData.t)}"
                        class="w-full bg-dark-600 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-accent/50">
                </div>
                <div>
                    <label class="text-xs text-gray-400 mb-1 block">Artist</label>
                    <input type="text" id="edit-artist" value="${_escAttr(songData.a)}"
                        class="w-full bg-dark-600 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-accent/50">
                </div>
                <div>
                    <label class="text-xs text-gray-400 mb-1 block">Album</label>
                    <input type="text" id="edit-album" value="${_escAttr(songData.al)}"
                        class="w-full bg-dark-600 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-accent/50">
                </div>
                <div>
                    <label class="text-xs text-gray-400 mb-1 block">Year</label>
                    <input type="text" inputmode="numeric" id="edit-year" value="${_escAttr(songData.y)}" placeholder="e.g. 2024"
                        class="w-full bg-dark-600 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-accent/50">
                </div>
            </div>
            <div class="flex gap-3 mt-5">
                <button data-edit-save
                    class="flex-1 bg-accent hover:bg-accent-light px-4 py-2 rounded-xl text-sm font-semibold text-white transition">Save</button>
                <button data-edit-close
                    class="px-4 py-2 bg-dark-600 hover:bg-dark-500 rounded-xl text-sm text-gray-300 transition">Cancel</button>
            </div>
            <div class="mt-4 pt-4 border-t border-gray-800">
                <button data-delete-filename="${_escAttr(songData.f)}"
                    class="w-full px-4 py-2 bg-red-900/30 hover:bg-red-900/60 border border-red-900/50 hover:border-red-700 rounded-xl text-sm text-red-300 hover:text-red-100 transition">Remove from library</button>
            </div>
        </div>`;
    document.body.appendChild(modal);

    // Move focus into the dialog's first text input so background
    // shortcuts (and arrow nav) can't fire on the underlying library
    // entry while the edit form is open. Title is the natural primary
    // field — most edits are correcting spelling there. Caret-end
    // selection so the user can keep typing rather than overtype the
    // current value.
    const titleInput = document.getElementById('edit-title');
    if (titleInput) {
        titleInput.focus({ preventScroll: true });
        try {
            const len = titleInput.value.length;
            titleInput.setSelectionRange(len, len);
        } catch { /* some browsers reject selection on certain input types */ }
    }

    // Trap Tab / Shift+Tab inside the modal so focus can't escape to
    // the library content underneath while the edit form is open.
    _trapFocusInModal(modal);

    // Click on art triggers file input
    document.getElementById('edit-art-wrapper').addEventListener('click', () => {
        document.getElementById('edit-art-file').click();
    });

    // Save — wired in JS (not an inline onclick) so the filename never has to
    // survive embedding in a single-quoted attribute string. encodeURIComponent
    // does NOT escape `'`, so a filename like `Bob's Song.sloppak` used to break
    // the inline `saveEditModal('…')` handler and silently fail the save. The
    // raw filename lives in the closure; encode it here for saveEditModal.
    const saveBtn = modal.querySelector('[data-edit-save]');
    if (saveBtn) {
        saveBtn.addEventListener('click', () => saveEditModal(encodeURIComponent(songData.f)));
    }

    const deleteBtn = modal.querySelector('[data-delete-filename]');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
            deleteSongFromModal(deleteBtn.dataset.deleteFilename);
        });
    }

    // Close on backdrop click or Cancel button; restore focus to opener.
    // Backdrop dismissal requires the gesture's mousedown to have STARTED on
    // the backdrop — not just the click/mouseup to land there. Otherwise a
    // click-drag that begins inside a field (e.g. selecting text) and is
    // released past the modal edge resolves its `click` target to the backdrop
    // and silently discards the edit. Cancel / ✕ (data-edit-close) always close.
    let _downOnBackdrop = false;
    modal.addEventListener('mousedown', (e) => { _downOnBackdrop = (e.target === modal); });
    modal.addEventListener('click', (e) => {
        if (!_editModalShouldClose(e.target, modal, _downOnBackdrop)) return;
        const opener = modal._opener;
        modal.remove();
        const focusTarget = (opener && document.body.contains(opener)) ? opener
            : (_lastLibSelected && document.body.contains(_lastLibSelected) ? _lastLibSelected : null);
        if (focusTarget) focusTarget.focus({ preventScroll: true });
    });
}

// Whether a click on the edit-metadata modal should dismiss it. The Cancel / ✕
// control (data-edit-close) always dismisses. A backdrop dismissal needs BOTH
// the click target to be the backdrop element itself AND the gesture to have
// started there (downOnBackdrop) — so a click-drag begun inside a field and
// released on the backdrop does not discard the form. Pure + top-level so it's
// unit-testable in isolation.
function _editModalShouldClose(clickTarget, modalEl, downOnBackdrop) {
    if (clickTarget && clickTarget.closest && clickTarget.closest('[data-edit-close]')) return true;
    return clickTarget === modalEl && downOnBackdrop === true;
}

function previewEditArt(input) {
    if (!input.files || !input.files[0]) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        document.getElementById('edit-art-preview').src = e.target.result;
    };
    reader.readAsDataURL(input.files[0]);
}

async function saveEditModal(encodedFilename) {
    const filename = decodeURIComponent(encodedFilename);

    // Save metadata
    await fetch(`/api/song/${encodeURIComponent(filename)}/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title: document.getElementById('edit-title').value.trim(),
            artist: document.getElementById('edit-artist').value.trim(),
            album: document.getElementById('edit-album').value.trim(),
            // Year is normalised server-side (non-numeric/empty → ""), so a
            // blank or cleared field round-trips safely.
            year: document.getElementById('edit-year').value.trim(),
        }),
    });

    // Upload art if changed
    const fileInput = document.getElementById('edit-art-file');
    if (fileInput.files && fileInput.files[0]) {
        const reader = new FileReader();
        reader.onload = async (e) => {
            await fetch(`/api/song/${encodeURIComponent(filename)}/art/upload`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: e.target.result }),
            });
        };
        reader.readAsDataURL(fileInput.files[0]);
    }

    const modal = document.getElementById('edit-modal');
    const opener = modal ? modal._opener : null;
    if (modal) modal.remove();
    // Restore focus to the entry the modal was opened from so subsequent
    // keyboard navigation resumes correctly (same as Esc / Cancel paths).
    const focusTarget = (opener && document.body.contains(opener)) ? opener
        : (_lastLibSelected && document.body.contains(_lastLibSelected) ? _lastLibSelected : null);
    if (focusTarget) focusTarget.focus({ preventScroll: true });
    // Refresh current view
    const activeScreen = document.querySelector('.screen.active');
    if (activeScreen?.id === 'favorites') loadFavorites();
    else loadLibrary();
}

async function deleteSongFromModal(filename) {
    const title = (document.getElementById('edit-title')?.value || filename).trim();
    const ok = await _confirmDialog({
        title: 'Remove from library?',
        body: `<p class="text-sm text-gray-300">Remove <span class="font-semibold text-white">${_escAttr(title)}</span> from your library?</p>
               <p class="text-xs text-red-400/90 mt-2">This permanently deletes the file from disk. This cannot be undone.</p>`,
        confirmText: 'Remove',
        cancelText: 'Cancel',
        danger: true,
    });
    if (!ok) return;
    let resp;
    try {
        resp = await fetch(`/api/song/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    } catch (e) {
        alert(`Delete failed: ${e.message}`);
        return;
    }
    if (!resp.ok) {
        let msg = resp.statusText;
        try { msg = (await resp.json()).error || msg; } catch (_) {}
        alert(`Delete failed: ${msg}`);
        return;
    }
    const modal = document.getElementById('edit-modal');
    if (modal) modal.remove();
    _treeStats = null;
    _favTreeStats = null;
    _tuningNames = null;

    // Remove the deleted song's card from any currently-rendered grid/tree
    // so the user sees it disappear without waiting for a refetch. A full
    // loadLibrary() here would re-call loadGridPage(currentPage), which
    // uses 'append' mode when currentPage > 0 and re-appends the same
    // (now-shortened) page on top of what's already rendered — leaving
    // the deleted card visible. Direct DOM removal also preserves scroll
    // position, which a refetch from page 0 would lose.
    _removeLibCardsForFilename(filename);

    // Tree views group by artist with song counts; a single card removal
    // leaves stale counts, so refresh the tree for whichever screen we're
    // looking at (each tree-view renderer replaces innerHTML cleanly).
    const activeScreen = document.querySelector('.screen.active');
    if (activeScreen?.id === 'favorites') {
        // loadFavorites() routes to either loadFavGridPage (always
        // 'replace') or loadFavTreeView — both safe for a single delete.
        loadFavorites();
    } else if (libView === 'tree') {
        loadTreeView();
    }
    // Main library grid view: DOM removal above is sufficient.
}

function _removeLibCardsForFilename(filename) {
    // The grid uses data-play="<encoded filename>" on each card; the
    // tree's song rows use the same attribute. encodeURIComponent
    // matches what renderGridCards / the tree renderer emit.
    const encoded = encodeURIComponent(filename);
    const selector = `[data-play="${CSS.escape(encoded)}"]`;
    let removed = 0;
    for (const el of document.querySelectorAll(selector)) {
        el.remove();
        removed++;
    }
    if (removed === 0) return;
    // Decrement the visible count badges that loadGridPage / loadTreeView
    // populated. Counts come from the server's `total` so this is a
    // best-effort estimate until the next refetch, but it keeps the
    // displayed number consistent with what's on screen right now.
    for (const id of ['lib-count', 'fav-count']) {
        const el = document.getElementById(id);
        if (!el) continue;
        const m = (el.textContent || '').match(/^(\d+)/);
        if (!m) continue;
        const next = Math.max(0, parseInt(m[1], 10) - removed);
        el.textContent = (el.textContent || '').replace(/^\d+/, String(next));
    }
    _bumpLibNavGeneration();
}

async function syncLibrarySong(providerId, songId, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const { playWhenReady = false } = opts;
    if (!providerId || !songId) return;
    const currentState = _librarySyncState(providerId, songId);
    if (currentState && currentState.status === 'synced' && currentState.localFilename) {
        if (playWhenReady) playSong(encodeURIComponent(currentState.localFilename), undefined, { bridge: false });
        return currentState.result || { filename: currentState.localFilename };
    }
    if (currentState && currentState.status === 'syncing') return null;
    _setLibrarySyncState(providerId, songId, { status: 'syncing' });
    try {
        const capabilityApi = window.feedBack && window.feedBack.capabilities;
        let data = null;
        if (capabilityApi && typeof capabilityApi.command === 'function') {
            const result = await capabilityApi.command('library', 'sync-song', {
                requester: 'app.library',
                target: { providerId, songId },
                payload: opts,
            });
            if (result.outcome !== 'handled') throw new Error(result.reason || 'Library provider sync failed');
            data = result.payload && result.payload.result;
        } else {
            data = await _libraryProviderApi()?.syncSong?.(providerId, songId, opts);
        }
        if (!data) throw new Error('Library provider sync did not return a result');
        const localFilename = data.filename || data.localFilename || data.local_filename || data.playFilename || data.play_filename || '';
        const message = localFilename
            ? 'Ready to play'
            : (data.cachedPath ? 'Loaded to local cache' : 'Loaded');
        _setLibrarySyncState(providerId, songId, { status: 'synced', message, localFilename, result: data });
        _treeStats = null;
        _favTreeStats = null;
        _tuningNames = null;
        _libEpoch++;
        await loadLibrary(0);
        if (playWhenReady && localFilename) playSong(encodeURIComponent(localFilename), undefined, { bridge: false });
        return data;
    } catch (error) {
        _setLibrarySyncState(providerId, songId, { status: 'error', message: error.message || 'Unknown error' });
        console.warn('Remote library load failed:', error);
        return null;
    }
}

function _setLibrarySyncState(providerId, songId, state) {
    _librarySyncStates.set(_librarySyncKey(providerId, songId), state);
    _renderLibrarySyncState(providerId, songId);
}

function _renderLibrarySyncState(providerId, songId) {
    const state = _librarySyncState(providerId, songId);
    // Filter via dataset rather than building a CSS attribute selector —
    // CSS.escape is absent in some test environments and older runtimes,
    // and provider/song IDs are not constrained to CSS-safe strings.
    const encodedProvider = encodeURIComponent(providerId);
    const encodedSong = encodeURIComponent(songId);
    for (const status of document.querySelectorAll('[data-library-sync-status]')) {
        if (status.dataset.librarySyncProvider !== encodedProvider) continue;
        if (status.dataset.librarySyncSong !== encodedSong) continue;
        const layout = status.classList.contains('ml-1') ? 'inline' : 'block';
        status.className = _librarySyncStatusClass(state, layout);
        status.textContent = _librarySyncStatusText(state);
    }
}

// Delegated click handlers
document.addEventListener('click', e => {
    // Edit button
    const edit = e.target.closest('.edit-btn');
    if (edit) {
        e.stopPropagation();
        const entry = edit.closest('[data-play]');
        openEditModal(JSON.parse(edit.dataset.edit), entry);
        return;
    }
    // Favorite button
    const fav = e.target.closest('.fav-btn');
    if (fav) {
        e.stopPropagation();
        toggleFavorite(decodeURIComponent(fav.dataset.fav));
        return;
    }
    // Retune button
    const btn = e.target.closest('.retune-btn');
    if (btn) {
        e.stopPropagation();
        retuneSong(btn.dataset.retune, decodeURIComponent(btn.dataset.title), btn.dataset.tuning, btn.dataset.target || 'E Standard');
        return;
    }
    // Remote song card / row without a local playable file yet.
    const remoteEntry = e.target.closest('[data-library-song]');
    if (remoteEntry && !remoteEntry.dataset.play && !e.target.closest('button')) {
        const providerId = decodeURIComponent(remoteEntry.dataset.libraryProvider || '');
        if (!_providerSupports(providerId, 'song.sync')) return;
        _setLibSelection(remoteEntry, { focus: false });
        syncLibrarySong(
            providerId,
            decodeURIComponent(remoteEntry.dataset.librarySong || ''),
            { playWhenReady: true },
        );
        return;
    }
    // Song card / row — keep persistent selection in sync with mouse
    // clicks so arrow-keying after a click resumes from where the
    // user clicked, not from a stale highlight.
    // Guard: if the click originated from any <button> inside the
    // entry (e.g. a plugin-provided .sloppak-convert-btn that has no
    // own stopPropagation handler above), don't treat it as a play
    // action. Known action buttons (.fav-btn, .edit-btn, .retune-btn)
    // already return early via stopPropagation() above; this catches
    // any remaining button that bubbles through.
    const card = e.target.closest('[data-play]');
    if (card && !e.target.closest('button')) {
        _setLibSelection(card, { focus: false });
        playSong(card.dataset.play, undefined, { bridge: false });
    }
});

// ── Scan banner (non-blocking) ──────────────────────────────────────────
function showScanBanner() {
    if (document.getElementById('scan-banner')) return;
    const el = document.createElement('div');
    el.id = 'scan-banner';
    el.className = 'fixed bottom-0 left-0 right-0 z-50 bg-dark-700/95 backdrop-blur border-t border-gray-700 px-6 py-3 flex items-center gap-4';
    el.innerHTML = `
        <div class="flex-1">
            <div class="flex items-center gap-3 mb-1">
                <span class="text-sm font-semibold text-white">Importing Library</span>
                <span class="text-xs text-gray-400" id="scan-progress">0 / 0</span>
            </div>
            <div class="progress-bar"><div class="fill" id="scan-bar" style="width:0%"></div></div>
            <p class="text-xs text-gray-500 mt-1 truncate" id="scan-file">Starting...</p>
            <p class="text-xs text-blue-400/70 mt-1 hidden" id="scan-first-note">First-time import — results are cached for future launches</p>
        </div>
        <button onclick="hideScanBanner()" class="px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-400 transition flex-shrink-0">Dismiss</button>`;
    document.body.appendChild(el);
}

function hideScanBanner() {
    const el = document.getElementById('scan-banner');
    if (el) el.remove();
}

let _scanPollId = null;

async function pollScanStatus() {
    try {
        const resp = await fetch('/api/scan-status');
        const data = await resp.json();
        if (data.stage === 'error' && data.error) {
            // Surface the error in the banner and stop polling.
            showScanBanner();
            const file = document.getElementById('scan-file');
            const prog = document.getElementById('scan-progress');
            const firstNote = document.getElementById('scan-first-note');
            if (file) { file.textContent = 'Scan failed: ' + data.error; file.classList.add('text-red-400'); }
            if (prog) prog.textContent = 'Error';
            if (firstNote) firstNote.classList.add('hidden');
            clearInterval(_scanPollId);
            _scanPollId = null;
            return;
        }
        if (data.running) {
            showScanBanner();
            const pct = data.total > 0 ? Math.round(data.done / data.total * 100) : 0;
            const bar = document.getElementById('scan-bar');
            const prog = document.getElementById('scan-progress');
            const file = document.getElementById('scan-file');
            const firstNote = document.getElementById('scan-first-note');
            if (bar) bar.style.width = pct + '%';
            if (prog) prog.textContent = `${data.done} / ${data.total} (${pct}%)`;
            if (file) {
                const name = (data.current || '').replace(/_p\.archive$/i, '').replace(/_/g, ' ');
                file.textContent = name || (data.stage === 'listing' ? 'Listing DLC folder...' : 'Processing...');
            }
            if (firstNote) firstNote.classList.toggle('hidden', !data.is_first_scan);
        } else {
            if (document.getElementById('scan-banner')) {
                hideScanBanner();
                _treeStats = null;  // Refresh stats
                loadLibrary();
            }
            clearInterval(_scanPollId);
            _scanPollId = null;
        }
    } catch (e) { /* ignore */ }
}

async function checkScanAndLoad() {
    const resp = await fetch('/api/scan-status');
    const data = await resp.json();
    if (data.running) {
        showScanBanner();
        const firstNote = document.getElementById('scan-first-note');
        if (firstNote) firstNote.classList.toggle('hidden', !data.is_first_scan);
        _scanPollId = setInterval(pollScanStatus, 1000);
    }
    loadLibrary();
}

// ── Plugin loader ───────────────────────────────────────────────────────
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

async function loadPlugins() {
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
                    item.onclick = (e) => { e.preventDefault(); ddMenu.classList.add('hidden'); showScreen(screenId); window.feedBackDemoTrack?.('event/plugin-open/' + plugin.id); };
                    ma.className = 'text-gray-400 hover:text-white pl-4 text-sm';
                    ma.textContent = label;
                    ma.onclick = (e) => { e.preventDefault(); showScreen(screenId); ma.closest('#mobile-menu').classList.add('hidden'); window.feedBackDemoTrack?.('event/plugin-open/' + plugin.id); };
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

async function bootstrapPluginsAndUi() {
    // #421: never gate the nav on full plugin startup. Render it immediately
    // from /api/plugins (ready plugins active; installing/failed disabled),
    // then stream plugin status so each entry resolves in place as its
    // dependencies finish installing or its load fails.
    const plugins = await loadPlugins();
    _streamPluginStartup();
    return plugins;
}

// Load library on start. loadSettings is awaited alongside so persisted
// values (A/V offset, mastery, etc.) are applied to the highway + HUD
// before any playSong runs — otherwise a fast click could start
// playback with stale settings before /api/settings returned.
(async () => {
    // Splitscreen pop-out windows (`?ssFollower=1`) load this same app but
    // get driven into "follower mode" by the splitscreen plugin once it
    // loads — which is *after* this init runs. Without this, the library
    // (`#home`, marked `active` in index.html) renders and paints first, so
    // the popup briefly flashes the song grid before swapping to the player.
    // Switch to the player screen up front so the popup shows player chrome
    // (empty, then populated by the plugin) the whole time. The wasted
    // library fetch below is negligible next to the whole-app + every-plugin
    // re-load a popup already does.
    const isFollowerWindow = (() => {
        try { return new URLSearchParams(location.search).get('ssFollower') === '1'; }
        catch (_) { return false; }
    })();
    if (isFollowerWindow) {
        // Await it — showScreen is async, so a bare call would turn even a
        // synchronous DOM error into an unhandled rejection that this try
        // couldn't catch. Surface failures (e.g. `#player` missing/renamed)
        // instead of silently bringing the library flash back.
        try { await showScreen('player'); }
        catch (e) { console.warn('[feedBack] follower-window: showScreen("player") failed:', e); }
    }
    await loadLibraryProviders({ restoreSaved: true });
    // Restore library-filter UI state from localStorage before the first
    // grid fetch so the badge/chips are accurate immediately
    // (feedBack#129).
    _renderLibFilterChips();
    _updateLibFiltersBadge();
    // Restore the persisted sort and format-filter dropdowns BEFORE
    // the first setLibView() call — setLibView triggers loadLibrary,
    // which reads `lib-sort` / `lib-format` to build the API query
    // string. Without this, the first page would always load with
    // "Artist A-Z" / "All formats" regardless of what the user had
    // picked previously.
    const savedSort = _readPersistedChoice(_LIB_SORT_KEY, _LIB_SORT_VALUES, 'artist');
    const savedFormat = _readPersistedChoice(_LIB_FORMAT_KEY, _LIB_FORMAT_VALUES, '');
    const sortEl = document.getElementById('lib-sort');
    const fmtEl = document.getElementById('lib-format');
    if (sortEl) sortEl.value = savedSort;
    if (fmtEl) fmtEl.value = savedFormat;
    // Treat the initial page load the same as a screen entry so the
    // restored selection scrolls into view exactly once on hard
    // reload. Without this, the scroll-on-screen-entry flag only
    // ever triggered when the user navigated away and back via
    // showScreen — a hard refresh in tree mode would land on the
    // top of the tree and force the user to scroll back to find
    // their selection.
    _libScrollOnNextRender.home = true;
    // `libView` was already initialized from localStorage at module
    // load; passing it through setLibView replays the visibility
    // toggling and triggers the initial load.
    setLibView(libView);
    try { await loadSettings(); } catch (e) { console.warn('initial loadSettings failed:', e); }
    // Re-apply any saved per-string highway colors to both highways.
    try { initHighwayColors(); } catch (e) { console.warn('initHighwayColors failed:', e); }
    // App-wide restart banner — must wire once, outside loadSettings(), so a
    // download finishing while the user is on a non-Settings screen still
    // pops the banner.
    try { initAppUpdateBanner(); } catch (e) { console.warn('initAppUpdateBanner failed:', e); }
    // Seed the track fill on every themed slider so they render correctly
    // before any interaction — e.g. the speed slider (untouched by
    // loadSettings) before the first playSong, or follower windows that
    // enter the player screen via showScreen('player') without playSong.
    document.querySelectorAll('.slider-input').forEach(el => handleSliderInput(el));
    try { _wireSpeedPresetsOnce(); } catch (e) { console.warn('_wireSpeedPresetsOnce failed:', e); }
    checkScanAndLoad();

    const plugins = await bootstrapPluginsAndUi();
    await loadLibraryProviders({ restoreSaved: true, reloadOnChange: true });
    // Viz picker depends on plugin scripts having loaded (to find
    // window.feedBackViz_<id> factories), so run it after loadPlugins.
    // Reuse the plugin list loadPlugins just fetched — no need to
    // round-trip /api/plugins a second time.
    _populateVizPicker(plugins);
    // Alpha-build heads-up banner — only revealed when the running version
    // string contains "alpha" (case-insensitive). Stays hidden on stable,
    // beta, RC, or any other channel. The banner element lives in the
    // library-section markup; toggling the `hidden` Tailwind utility is the
    // entire surface area, so a test harness can sandbox this against a
    // minimal document stub.
    function _updateAlphaWarningBanner(version) {
        const banner = document.getElementById('alpha-warning-banner');
        if (!banner) return;
        const isAlpha = typeof version === 'string'
            && version.toLowerCase().includes('alpha');
        banner.classList.toggle('hidden', !isAlpha);
    }
    fetch('/api/version')
        .then(r => { if (!r.ok) throw new Error(); return r.json(); })
        .then(d => {
            const v = typeof d.version === 'string' ? d.version.trim() : '';
            if (v && v.toLowerCase() !== 'unknown') {
                const navEl = document.getElementById('app-version');
                if (navEl) navEl.textContent = 'v' + v;
                const aboutEl = document.getElementById('app-version-about');
                if (aboutEl) aboutEl.textContent = 'v' + v;
            }
            _updateAlphaWarningBanner(v);
            // Defense-in-depth: server validates the env-var-supplied URLs,
            // but the About <a href> values are configurable so the UI also
            // rejects anything that isn't http(s) with a non-empty hostname.
            // A bare regex prefix check would accept malformed values like
            // "https://" — `new URL` + protocol + hostname catches them
            // (and `hostname`, not `host`, so port-only authorities like
            // "http://:80/path" are rejected too).
            // The source and license links are checked independently so a
            // rejected source_url doesn't gate a valid license_url.
            const isSafeHref = (u) => {
                if (typeof u !== 'string' || !u) return false;
                try {
                    const parsed = new URL(u);
                    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
                    // `host` includes the port — "http://:80/path" has
                    // host ":80" but no real hostname. `hostname` is what
                    // we actually want.
                    return !!parsed.hostname;
                } catch (_) {
                    return false;
                }
            };
            if (isSafeHref(d.source_url)) {
                const srcLink = document.getElementById('about-source-link');
                if (srcLink) srcLink.href = d.source_url;
            }
            if (isSafeHref(d.license_url)) {
                const licLink = document.getElementById('about-license-link');
                if (licLink) licLink.href = d.license_url;
            }
        })
        .catch(() => {});
})();
