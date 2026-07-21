# Folder Library — FeedBack Plugin

![Core plugin](https://img.shields.io/badge/fee%5BdB%5Dack-core%20plugin-blue)
![Platform](https://img.shields.io/badge/platform-fee%5BdB%5Dack-darkblue)

A FeedBack (fee[dB]ack) plugin that organizes your `.sloppak` / `.feedpak` DLC songs into a folder tree, grouped by the folders on disk. Browse your whole library visually with album art, nest folders as deep as you like, switch between list and grid layouts, and manage folders without ever leaving the app.

---

## Screenshots

![Grid view](assets/grid-view.webp)
*Grid view — album art cards with title and artist*

![Grid search](assets/grid-search.png)
*Live search filters instantly across all folders*

![List view](assets/list-view.png)
*List view — compact rows with album art thumbnails and duration*

![New folder](assets/new-folder.png)
*Create and manage folders directly in the UI*

---

> **Status — migrating to core.** Folder Library is being reworked from a standalone plugin into a bundled core plugin, and several previously-shipped features are not currently wired up in core (see the Roadmap). The list below reflects what works today; if something here is wrong, it's because this rework is still in progress.

## Features

- **List & Grid views** — toggle between a compact list with thumbnails or a full album art card grid
- **Album art** — pulls art automatically for every song in both views
- **One-click playback** — click any song to start playing immediately
- **Preview song on hover** — hover a song briefly to preview its audio in place, with a waveform indicator over the art; toggle from the toolbar (on by default)
- **Sort options** — sort songs by title, artist, duration, year, tuning, or recently added with an asc/desc toggle
- **Advanced filters** — filter by arrangements, stems, lyrics, and tuning with include and exclude support
- **Folder management** — create, rename, and delete folders without leaving the plugin
- **Nested subfolders** — organize as deep as you want; create a subfolder inside any folder, expand/collapse a whole branch in one click
- **Collapsible folders** — expand/collapse individual folders, plus Expand All / Collapse All
- **Move songs** — reassign any song to a different folder on the fly; press `Esc` to cancel
- **Drag-and-drop** — drag songs between folders (including into nested folders) with smooth auto-scroll; press `Esc` to cancel
- **Fast with big libraries** — folder song lists render lazily and metadata is cached so reopening folders is instant

---

## Installation

Folder Library ships bundled with FeedBack as a core plugin (`"bundled": true`), so there's nothing to install — the **Folders** screen appears in the navbar under **Plugins** automatically.

---

## Usage

| Action | How |
|--------|-----|
| Switch to grid view | Click the grid icon in the toolbar |
| Switch to list view | Click the list icon in the toolbar |
| Play a song | Click any song row or card |
| Preview song on hover | On by default; click the toolbar button to toggle. When on, hovering a song ~0.8s previews its audio |
| Sort songs | Use the sort dropdown in the toolbar |
| Toggle sort direction | Click the arrow button next to the sort dropdown |
| Open filters | Click the filter icon in the toolbar |
| Filter by arrangement/stem | Open filters → click a pill to include; click `✕` to exclude |
| Clear all filters | Open filters → click "Clear all" |
| Create a folder | Click the folder+ icon in the toolbar |
| Create a subfolder | Hover a folder header → click the new-subfolder icon |
| Rename a folder | Hover the folder header → click the pencil icon |
| Delete a folder | Hover the folder header → click the trash icon (songs move up to Unsorted) |
| Move a song | Hover the song row → click the folder icon |
| Drag a song to a folder | Click and hold a song → drag to a folder header or body (nested folders work too) |
| Cancel a drag | Press `Esc` while holding a song |
| Cancel a move dialog | Press `Esc` in the move prompt |
| Expand / collapse a folder | Click the folder header |
| Expand / collapse all subfolders | Use the expand/collapse-children buttons on a folder with subfolders |

---

## Changelog

Folder Library started life as a standalone plugin with its own version line, but it's now a **bundled core plugin** that ships with FeedBack. Its changes are tracked alongside the app in the repo-root [CHANGELOG.md](../../CHANGELOG.md), and it versions with the app rather than on its own. The **Features** section above reflects what's in the current build.

---

## Roadmap

- [ ] Compatibility with core settings — respect Accessibility → Interface size
- [ ] Core parity — Metadata, Unmatched, and Upload should work in the folder view too
- [ ] Bulk move — select multiple songs and move them at once
- [ ] Thumbnail performance — faster loading and smoother scrolling with large song libraries
- [ ] Adjustable thumbnail and row sizes — resize song cards and list rows to suit your preference
- [ ] Custom themes — switch between colour schemes to match your style
- [ ] Favoriting songs
- [ ] Editing song metadata

---

## Contributing

Pull requests are welcome. For major changes please open an issue first to discuss what you'd like to change.

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Commit your changes
4. Push to the branch and open a pull request
