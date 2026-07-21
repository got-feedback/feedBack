# Folder Library — AI Agent Guide

A FeedBack (fee[dB]ack) plugin that adds a **Folders** nav screen showing your `.sloppak` / `.feedpak` DLC songs grouped by the folder tree on disk. Create, rename, and delete folders (including **nested subfolders**) directly in the UI, move songs by drag-and-drop, and browse with sort and metadata filters.

> The host app is **FeedBack** (formerly "Slopsmith"). The frontend talks to the host through `window.feedBack`; `window.slopsmith` is a back-compat alias the host still exposes (`window.slopsmith = window.feedBack` in `static/app.js`). New code should prefer `window.feedBack`.

> ⚠️ **Status — bundled core plugin.** This plugin began as a standalone plugin and is now a bundled core plugin. `screen.js` has been unified into a **single surface factory** driving two entry points: the v3 library Folder view (host chrome — host search `#v3-search`/`#lib-filter`, host filter params, renders into `#lib-folder-tree`) and the classic v2 standalone Folders nav-tab (its own `#fb-search` + toolbar, renders into `#fb-tree`). **Folder search works on both surfaces** — typing in the relevant search box re-renders the tree. **Loose-folder songs** (directories with audio + an arrangement XML) are recognised as songs via the host `loosefolder.is_loose_song` predicate, so they appear in the tree alongside `.sloppak`/`.feedpak` bundles. Folder management, nested subfolders, collapsible folders + expand/collapse-all, drag-and-drop, move-song, sort, filters, and the hover metadata badges are wired on both surfaces; verify against a running build before relying on any of it.

## File Structure

```
plugin.json     Plugin manifest — id, name, nav entry, file declarations ("bundled": true core plugin)
routes.py       FastAPI backend — recursive DLC scan, folder tree + filters, folder/song mutations, two-level cache
screen.html     Plugin screen content — injected by the host into the plugin div automatically
screen.js       Frontend logic — recursive folder tree, search, sort, filters, drag-and-drop, modals
README.md       User-facing docs
```

## Architecture

This plugin follows the standard FeedBack plugin pattern (see the repo-root `CLAUDE.md` for the full plugin system reference).

- **Backend** (`routes.py`) — registers routes under `GET/POST /api/plugins/folder_library/`. Uses `context["get_dlc_dir"]()`, `context["extract_meta"]()`, and `context["log"]`. Scans `<dlc>/sloppak/` if it exists, otherwise `<dlc>/`. Recursively walks the tree and handles create/rename/delete folder and move-song operations on slash-separated folder paths.
- **Frontend** (`screen.js`) — plain vanilla JS in an IIFE. Fetches the tree from the backend on screen load, recursively renders collapsible folder sections (any depth) and song rows or cards (grid view). Uses `window.feedBack.on('screen:changed', ...)` (via the `window.slopsmith` alias) to trigger load when the user navigates here. Calls `window.playSong(filename)` on song click with the full relative path from the DLC root.
- **No dependencies** — no npm, no build step. Tailwind utility classes available globally from the host; the plugin uses only core-guaranteed utilities and inline styles, so it ships **no** `styles` manifest key.

## Critical Layout Lessons (Hard-Won)

These are non-obvious behaviours of the FeedBack desktop app (Electron) that took significant debugging to discover. They still apply unchanged.

### 1. Do NOT put an outer wrapper div in screen.html
The host automatically creates `<div id="plugin-folder_library" class="screen">` and injects `screen.html` content inside it. If you add your own outer div with `class="screen"`, you get a nested screen element which gets `display:none` applied, hiding all content.

**Wrong:**
```html
<div id="plugin-folder_library" class="screen">
  <div>toolbar</div>
  <div>content</div>
</div>
```

**Correct:**
```html
<!-- no outer wrapper — the host provides it -->
<div>toolbar</div>
<div>content</div>
```

### 2. The .screen CSS class sets display:none by default
`.screen { display: none }` and `.screen.active { display: block }`. There is no height set. The screen div gets its height purely from its content. Do not try to set height via CSS classes — use inline styles or JS if needed.

### 3. The host navbar is position:fixed with z-index:50
The navbar sits at `top:0, z-index:50`. Plugin toolbars must use `position:fixed; top:64px; z-index:40` to sit below the navbar. Use a solid `background-color` (not Tailwind bg classes — those may not apply correctly) to prevent content showing through.

### 4. Content must have padding-top to clear the fixed toolbar
Since the toolbar is `position:fixed`, it floats above the content. The content container needs enough `padding-top` (~120px) to ensure the first item isn't hidden behind the toolbar — the host navbar (64px) plus the plugin toolbar height (~56px). Adding more toolbar buttons increases this height, so if content is clipped, increase the padding further.

### 5. Electron blocks window.prompt() and window.confirm()
The desktop app is built on Electron, which throws `Error: prompt() is not supported`. Use a custom inline modal instead. See `_showModal()` in `screen.js` — it returns a Promise and supports both text input and confirm modes.

### 6. The nav plugin dropdown has z-index:50 and blocks clicks
When navigating to a plugin screen via the Plugins dropdown, the dropdown stays open and sits on top of the screen. Call `_closeDropdown()` on screen load to dismiss it. The dropdown element id is `plugin-dropdown`.

### 7. playSong() expects a relative path from the DLC root
`window.playSong()` expects the path relative to the DLC root with forward slashes, e.g. `sloppak/CH/Artist - Title.sloppak`. Not just the filename. The backend builds this in `_meta()` via `"/".join(p.relative_to(dlc).parts)` and returns it as each song's `filename`.

### 8. FastAPI POST routes need `from fastapi import Request`
Routes that receive a JSON body must import `Request` from fastapi explicitly and use `async def route(request: Request)` with `body = await request.json()`. Missing this import crashes the server on plugin load.

### 9. Plugin id must be consistent everywhere
The plugin id (`folder_library`) must match in:
- `plugin.json` → `"id"` and `"nav.screen"`
- `screen.js` → `PLUGIN_ID` constant and `API` constant (`/api/plugins/folder_library`)
- `routes.py` → `APIRouter(prefix="/api/plugins/folder_library")`

A mismatch in any of these causes silent failures (blank screen, 404 API calls).

### 10. Use inline styles for grid layout, not Tailwind
Tailwind's `grid` and `grid-cols-*` classes may not apply reliably inside the plugin div. Use `element.style.cssText` with explicit `display:grid; grid-template-columns:...` for the grid container.

## Key Conventions

- **IIFE + `'use strict'`** — all frontend code wrapped in `(function(){ 'use strict'; ... })();`
- **localStorage prefixes** — plugin keys are prefixed `fo:` (e.g. `fo:view`, `fo:sort`, `fo:filters`); host-library-synced filter state uses `fo:lib:`. Open-folder state is tracked by **folder path** (so nested folders each remember their own state).
- **Safe storage access** — all `localStorage` reads/writes wrapped in try/catch
- **Logging** — backend uses `context["log"]`, never `print()`
- **Sibling imports** — use `context["load_sibling"]("name")` not bare `import name` (none needed today; keep this in mind if you add helper modules)

## Song Formats

The plugin treats both `.sloppak` and `.feedpak` as songs (`_is_song()` in `routes.py`). `feedpak` is the published name for the same on-disk format the codebase still calls `sloppak` internally — see the repo-root `CLAUDE.md`. Both file form (`.sloppak`/`.feedpak` zip) and directory form (`*.sloppak/` folder) are recognized.

## Backend Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/plugins/folder_library/tree` | Returns the folder tree. Accepts optional filter query params (below) applied server-side. |
| POST | `/api/plugins/folder_library/folder/create` | Body: `{name, parent?}` — creates a subfolder; `parent` (slash path) nests it inside an existing folder, omit/empty for top level |
| POST | `/api/plugins/folder_library/folder/rename` | Body: `{old, new}` — `old` is a slash path, `new` is a bare name; renames within the same parent |
| POST | `/api/plugins/folder_library/folder/delete` | Body: `{name}` (slash path) — moves all songs at any depth to the scan root, then removes the folder |
| POST | `/api/plugins/folder_library/song/move` | Body: `{filename, folder}` — moves a song to `folder` (slash path; empty = scan root / "Unsorted") |

### `/tree` filter query params

All optional, applied server-side over the cached full tree by `_apply_tree_filters()`. Comma-separated, case-insensitive:

- `arrangements_has`, `arrangements_lacks` — include/exclude by arrangement name
- `stems_has`, `stems_lacks` — include/exclude by stem name
- `has_lyrics` — `""` (any), `"1"`, or `"0"`
- `tunings` — comma-separated tuning names to include

The frontend forwards the host library's active filter params here (via `window.feedBackLibFilterParams()` when present, with `window.slopsmithLibFilterParams()` as a legacy fallback) so the Folders view can stay in sync with the main library filters, falling back to its own filter panel state otherwise.

### Path safety

`_safe_name()` rejects empty names, leading/trailing whitespace, the characters `\ / : * ? " < > |`, and `.`/`..`. `_safe_path()` applies `_safe_name()` to every slash-separated segment, so traversal (`..`) and absolute paths are rejected before any filesystem op. Always validate user-supplied folder paths through these before touching disk.

## Tree Shape

`/tree` returns:

```json
{
  "folders": [
    {
      "name": "CH",
      "path": "CH",
      "songs": [ /* song objects */ ],
      "children": [
        { "name": "Live", "path": "CH/Live", "songs": [], "children": [] }
      ]
    }
  ],
  "root_songs": [ /* songs sitting directly in the scan root — shown as "Unsorted" */ ]
}
```

Folder nodes are **recursive**: each has `name`, `path` (slash-separated, relative to the scan root), `songs`, and `children`. The frontend renders any depth — `_findFolderByPath()`, `_countDeep()`, and `_countFoldersDeep()` walk the `children` arrays.

## Song Metadata Format

Each song object (built by `_meta()`):

```json
{
  "filename": "sloppak/CH/Artist - Title.sloppak",
  "title": "Title",
  "artist": "Artist",
  "album": "Album Name",
  "duration": 213.5,
  "year": 1993,
  "tuning": "E Standard",
  "added": 1748132400.0,
  "arrangements": ["Lead", "Rhythm", "Bass"],
  "stems": ["Drums", "Bass", "Vocals"],
  "lyrics": true
}
```

- `filename` is the full relative path from the DLC root — pass it directly to `window.playSong()`.
- `added` is a Unix timestamp (float, seconds) from `stat().st_mtime` — convert with `new Date(added * 1000)`. Always recomputed fresh (it changes when a file moves), even on a metadata-cache hit.
- `arrangements` / `stems` are flat lists of **strings**, even though `extract_meta()` returns them as objects.
- Hover-preview isn't resolved here at all — the cards just carry `data-fn`/`data-v3-play` markup and the `song_preview` plugin handles it (see Preview on Hover).

### extract_meta returns arrangements/stems as objects, not strings

`context["extract_meta"]()` returns arrangements as a list of objects `{index, name, notes}`, not plain strings; stems similarly. `_meta()` normalizes to `.name`:

```python
raw_arr = raw.get("arrangements") or []
m["arrangements"] = [
    a["name"] if isinstance(a, dict) else str(a)
    for a in raw_arr
    if (isinstance(a, dict) and "name" in a) or isinstance(a, str)
]
```

`lyrics` is coerced to a bool from several possible keys (`lyrics`, `hasLyrics`, `has_lyrics`, …). If you add new metadata fields from `extract_meta`, check the raw shape before assuming it's a plain value.

## Two-Level Cache

`routes.py` keeps two caches inside `setup()`:

- **`_meta_cache`** — expensive `extract_meta()` results keyed by absolute POSIX path. **Never cleared.** When files move (rename/delete/move), the keys are rewritten in-place so the warm data survives the operation.
- **`_cache`** — the assembled tree structure (`folders` / `root_songs`). Cleared by `_invalidate()` on **every** mutation so the next `/tree` rebuilds it — but the rebuild is fast because `_meta_cache` is still warm.

`filename` and `added` are deliberately **not** stored in `_meta_cache` (they depend on the file's current location) — they're recomputed on every `_meta()` call and merged onto the cached copy. When you add a mutation route, mirror the existing key-rewrite logic (see `rename_folder`, `delete_folder`, `move_song`) so the metadata cache stays valid.

## Folder Scan Logic

`routes.py` scans recursively starting at `<dlc>/sloppak/` (or `<dlc>/` if no `sloppak` subdir exists):
- Files/dirs matching `.sloppak` or `.feedpak` → song entries (root-level ones go to `root_songs`, shown as "Unsorted")
- Subdirectories → recursive folder nodes with their own `songs` + `children`
- Dot-prefixed entries are skipped; empty folders are still included (shown with a 0 count)

To add more grouping options (by artist, album, etc.), build an alternative projection over the scanned songs rather than the on-disk tree.

## Library provider (future, not implemented)

This plugin surfaces folders as a dedicated **view** over the existing library;
it does not (yet) register itself as a selectable library **source/provider**.
If you want a "Folders" entry to appear in the host's main library-source
picker (mapping top-level folder → "artist", subfolder → "album"), implement a
provider exposing the source-aware contract (`query_page`, `query_artists`,
`query_stats`, `tuning_names`) and register it in `setup()` via
`context["register_library_provider"](...)`, unregistering on teardown. (An
earlier inert `FolderLibraryProvider` scaffold was removed — it was never wired
and only duplicated the scan logic; re-add it only alongside real registration
and tests.)

## View Modes (List / Grid)

The toolbar has a list/grid toggle. Current view is stored in `localStorage` under `fo:view` (`'list'` or `'grid'`).

- **List view** — `_songRow()`, rendered inside a `ml-5 space-y-0` div
- **Grid view** — `_songCard()`, rendered inside a CSS grid div (`auto-fill, minmax(150px,1fr)`)
- Both the folder and unsorted section renderers branch on `_view` to pick the right renderer and container
- Album art is fetched via `/api/song/<encoded-path>/art` where each path segment is individually `encodeURIComponent`-encoded. On error the `<img>` is hidden and a placeholder SVG is shown
- The collapse/expand toggle restores `display:grid` (not just `display:''`) when reopening a folder in grid mode — always check this when changing toggle logic

### Lazy folder rendering

Folders do **not** render their song list on initial load. The folder renderer sets a `_listPopulated` flag and only populates the list the first time a folder is opened, keeping the initial render fast with large libraries. When search is active all folders are forced open and populated immediately (search overrides lazy loading).

## Sort System

The toolbar has a sort select (`#fb-sort`) and a direction toggle (`#fb-sort-dir`). State is stored under `fo:sort` and `fo:sortDir`.

- `_sort` — `'default' | 'title' | 'artist' | 'duration' | 'year' | 'tuning' | 'added'`
- `_sortDir` — `'asc' | 'desc'`
- `_sortSongs(songs)` returns a sorted copy; direction is applied by reversing after sort. Returns the array unchanged when `_sort === 'default'`.
- The sort direction button is dimmed (`opacity: 0.35`) and non-interactive when sort is `'default'`.

## Filter System

Client-side filters are stored under `fo:filters` as a JSON object. (The server `/tree` endpoint can also filter — see Backend Routes — used to sync with the host library.)

### Filter state shape

```js
_filters = {
    arrangements: { Lead: 'on', Bass: 'exclude', Rhythm: 'off' },
    stems:        { Drums: 'off' },
    lyrics:       'off',   // 'off' | 'on' | 'exclude'
    tunings:      ['E Standard', 'Eb Standard'],
}
```

Each arrangement/stem value is `'off' | 'on' | 'exclude'`.

### Include vs exclude logic

`_matchFilters(song)` uses **OR logic for includes, AND logic for excludes**:

- **Include (`'on'`)** — song passes if it has *at least one* selected arrangement/stem. More includes widens the result set.
- **Exclude (`'exclude'`)** — each excluded tag independently removes songs that have it. More excludes narrows the result set.

This matches standard multi-select filter UX (Spotify/library style).

### Data-driven filter panel

All filter sections are built from the actual library data — nothing is hardcoded:

- `_getArrangements()` — unique arrangement names sorted by frequency (most common first), then alphabetically
- `_getStems()` — same pattern for stem names
- `_getAvailableFilters()` — returns `{ arrangements, stems, lyrics, tuning }` booleans gating the lyrics/tuning sections

Non-standard arrangement names (e.g. `"Bonus"`) appear as pills automatically — no constants to update. The stems section only appears if at least one song has stems data.

### Split pill UI

`_makeSplitPill(label, state, onChange)` renders a two-zone pill:
- Left zone (label) — toggles `'off' ↔ 'on'` (include, blue)
- Right zone (`✕`) — toggles `'off' ↔ 'exclude'` (exclude, red)

The filter badge (`#fb-filter-badge`) shows the active filter count via `_activeFilterCount()`.

## Hover Badges

Each song row/card has two hidden hover-reveal layers, built once and toggled via CSS `max-height` + `opacity` transitions.

### `_badge(text, active, type)`

Renders a single metadata badge. Type controls the inactive colour:

| type | inactive border | inactive text |
|---|---|---|
| `'arrangement'` | amber `#92400e` | amber `#fcd34d` |
| `'stem'` | violet `#5b21b6` | violet `#c4b5fd` |
| `'lyrics'` | rose `#9f1239` | rose `#fda4af` |
| `'tuning'` | teal `#0f766e` | teal `#5eead4` |

Active state is always blue (`#1d4ed8` fill, `#3b82f6` border, white text) regardless of type.

### `_buildSongBadges(song)`

Builds the badge row (arrangements, stems, lyrics, tuning), deduplicating within each category. Clicking a badge toggles that filter on/off and re-renders. Returns `null` if the song has no filterable metadata.

### `_buildSongDateInfo(song)`

Builds a separate plain-text hover line showing `year · date added` (e.g. `1993  ·  24 May 2026`), `#cbd5e1` text. Always shown on hover regardless of filter state.

### Reveal / hide

```js
_revealBadges(el)  // max-height:120px, opacity:1, margin-top:4px
_hideBadges(el)    // max-height:0, opacity:0, margin-top:0
```

Both badge layers (badges + date-info) are wired to the same `mouseenter`/`mouseleave` events on the row or card element.

## Drag-and-Drop

Drag-and-drop uses **pointer events** (mousedown/mousemove/mouseup), not the HTML5 DnD API. HTML5 DnD blocks wheel events and gives unreliable edge positions inside Electron — pointer events give full control.

- `_makeDraggable(el, song, folderName)` — attaches a `mousedown` listener. A drag goes "live" only after the pointer moves more than `_DRAG_THRESH` (5 px), preventing accidental drags on clicks.
- Once live, a ghost `div` follows the cursor. Auto-scroll activates when the pointer is within `_DRAG_ZONE` (150 px) of the viewport top/bottom.
- `_makeDropTarget(el, targetFolder)` — sets `data-dropFolder` so an element can receive drops. Both folder headers and song-list containers are drop targets — including **nested** folders (drop onto a subfolder header moves the song there).
- `_dragFindTarget(x, y)` — uses `document.elementsFromPoint` to find the topmost element with `data-dropFolder` under the cursor.
- **Esc to cancel** — `_onDragKeyDown` calls `_endPointerDrag()` on `Escape`, removing the ghost and clearing state without dropping.
- On a successful drop, `_executeDrop()` does an **optimistic UI update** (moves the song in the in-memory tree and re-renders) then calls `/song/move`. On API failure it reloads the full tree.
- A one-time `click` capture listener after mouseup suppresses the post-drag click so it doesn't trigger playback.

## Modal Behaviour

`_showModal(msg, withInput, defaultVal)` is the custom modal used for all prompts and confirms (Electron blocks `window.prompt()` / `window.confirm()`). It returns a Promise.

- `_confirm(msg)` — resolves `true` on OK, `null` on cancel
- `_prompt(msg, default)` — resolves the trimmed input string on OK, `null` on cancel
- **Esc cancels** — resolves with `null`, same as Cancel (applies to rename, delete, create folder/subfolder, move song)
- **Enter confirms** — submits, equivalent to OK

## Preview on Hover

The Folder Library does **not** implement hover-preview itself — the `song_preview` plugin does, for the whole app. Its hover loop finds song elements by the selector `#v3-songs [data-fn]` (with a `[data-v3-play]` playable surface) and its `MutationObserver` watches the `#v3-songs` subtree — and the folder view (`#lib-folder-tree`) renders **inside** `#v3-songs`. So all folder_library has to do is give each card/row the standard markup:

- **`_songCard`** — `card.dataset.fn = song.filename` (raw filename) + `data-v3-play` on the art wrap (the surface `song_preview` overlays its indicator on).
- **`_songRow`** — `row.dataset.fn = song.filename` + `data-v3-play` on the thumb.

`song_preview` then previews folder view exactly like the grid/list — same audio (its `/audio` endpoint), same availability/404 handling, same indicator — with **zero preview code here**. If you change the card/row structure, keep `data-fn` (raw, not URL-encoded) and a `[data-v3-play]` descendant, or `song_preview` will stop recognising the cards.

## Roadmap

Implemented since the original release: **nested subfolders** (recursive tree + create-inside-folder), drag-and-drop, sort, advanced filtering, server-side tree filtering synced to the host library, and the warm metadata cache. Hover-preview is provided by the `song_preview` plugin via the `data-fn` markup above (not implemented here).

Not yet implemented, in rough priority order:

- **Bulk move** — multi-select songs and move them all at once.
- **Thumbnail performance** — faster loading and smoother scrolling with large libraries.
- **Adjustable thumbnail/row sizes** — user-resizable song cards and list rows.
- **Custom themes** — switchable colour schemes.
- **Favoriting songs** — likely a new backend route plus a `fo:favorites` localStorage key.
- **Editing song metadata** — edit title, artist, album etc. in-plugin; needs new backend write routes.
- **Folders as a library source** — register a library provider so a "Folders" entry appears in the host's main library-source picker (see "Library provider (future)" above).
