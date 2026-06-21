# Sloppak / feedpak Format — moved

The full format specification that used to live here has moved to its own repository and is now
the **authoritative, versioned reference**:

> **📖 https://github.com/got-feedback/feedpak-spec**
> — normative spec ([`spec/feedpak-v1.md`](https://github.com/got-feedback/feedpak-spec/blob/main/spec/feedpak-v1.md)),
> JSON Schemas, examples, and a reference validator.

Update bookmarks to point there. This page is a thin pointer kept at the original path so existing
links keep resolving.

## Naming: `sloppak` here, `feedpak` in the spec

The published format is named **feedpak** (extension `.feedpak`, manifest key `feedpak_version`).
This codebase still uses the legacy **sloppak** name internally — `lib/sloppak.py`, the
`.sloppak` extension, `SLOPSMITH_*` env vars, etc. **They describe the same on-disk format.** The
rename is repo/public-facing only for now (see the top-level workspace `CLAUDE.md`), so when the
spec says `feedpak` / `feedpak_version`, the packs this server reads and writes today are the same
structure under the `.sloppak` name. The internal rename is a separate, later effort.

## Hand-editing a pack

For the practical "how do I edit my own pack" walkthrough (record your own stem, fix metadata,
swap cover art, replace a stem split), see the companion guide that stays in this repo:
[sloppak-hand-editing.md](sloppak-hand-editing.md).

## Where the format maps to code (this repo)

The spec is implementation-independent; this table is the feedback-specific bridge from format
concepts to the code that reads and writes them. It is **not** part of the format.

| For… | Read |
|---|---|
| Format detection, source resolution, zip unpacking | [lib/sloppak.py](../lib/sloppak.py) |
| Data classes (`Note`, `Chord`, `Arrangement`, `Song`, `Phrase`) | [lib/song.py](../lib/song.py) |
| Wire-format helpers (`*_to_wire` / `*_from_wire`) | [lib/song.py](../lib/song.py) |
| The reference pack writer (assembly pipeline) | [lib/sloppak_convert.py](../lib/sloppak_convert.py) |
| Drum-tab vocabulary and wire helpers | [lib/drums.py](../lib/drums.py) |
| Notation vocabulary and wire helpers | [lib/notation.py](../lib/notation.py) |
| Live streaming over WebSocket (consumes the same shapes) | `server.py` (`/ws/highway/{filename}`) |
| The plugin system (where new visualization consumers go) | [CLAUDE.md](../CLAUDE.md) |
| Tests | [tests/test_sloppak.py](../tests/test_sloppak.py), [tests/test_sloppak_convert.py](../tests/test_sloppak_convert.py) |

> **Note on older section references.** Some inline code comments in this repo cite section
> numbers from the previous version of this document (e.g. "sloppak-spec §5.3"). The external spec
> renumbered its sections, so those citations are approximate — find the topic by name in the
> [feedpak spec](https://github.com/got-feedback/feedpak-spec/blob/main/spec/feedpak-v1.md)
> rather than by the old number.
