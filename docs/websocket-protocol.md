# Highway WebSocket protocol reference

The highway WebSocket at `/ws/highway/{filename}?arrangement={index}` streams a song's chart data to the player. Plugins that drive their own highway, replace the renderer (see [plugin-visualization-contracts.md](plugin-visualization-contracts.md)), or consume the stream directly all read these frames.

## Message order

Each connection receives the following JSON frames, roughly in this order:

| Message | Shape | Description |
|---------|-------|-------------|
| `loading` | `{ type: 'loading', stage }` | Status/progress message during extraction or conversion. |
| `song_info` | `{ type, title, artist, arrangement, arrangement_index, arrangements, duration, tuning, capo, format, audio_url, audio_error, stems }` | Song metadata. `arrangements` is the full list for the switcher. `audio_url` is `null` when audio is unavailable, in which case `audio_error` is non-null; otherwise `audio_error` is `null`. `stems` is always present — an empty array for non-sloppak songs or sloppak songs with no split stems. `tuning` is an array (6 for guitar, 4 for bass). |
| `beats` | `{ type, data: [{ time, measure }] }` | Beat timestamps with measure numbers. |
| `sections` | `{ type, data: [{ time, name }] }` | Named sections (Intro, Verse, Chorus, etc.). |
| `anchors` | `{ type, data: [{ time, fret, width }] }` | Fret zoom anchors. |
| `chord_templates` | `{ type, data: [{ name, frets: [6] }] }` | Named chord shapes. |
| `lyrics` | `{ type, data: [{ w, t, d }] }` | Syllables: `w`=word, `t`=time, `d`=duration. `-` joins to previous, `+` = line break. |
| `tone_changes` | `{ type: 'tone_changes', base, data: [{ time, name }] }` | Optional — tone change events relative to the arrangement base tone; only sent if tones were found. |
| `notes` | `{ type, data: [{ t, s, f, sus, ho, po, sl, bn, ... }] }` | Single notes. |
| `chords` | `{ type, data: [{ t, notes: [{ s, f, sus, ... }] }] }` | Chord events. |
| `phrases` | `{ type, data: [{ start_time, end_time, max_difficulty, levels: [...] }], total }` | Optional — per-phrase difficulty ladder for master-difficulty slider (slopsmith#48). Only sent when the source chart carries multi-level phrase data (PSARC / phrase-aware sloppak). Sent in chunks (`data` is a batch, `total` is the full count across messages) to avoid multi-MB single frames. Absent for GP imports and legacy sloppak; consumers must treat missing message as "single fixed difficulty — slider disabled". |
| `ready` | `{ type: 'ready' }` | All data sent — safe to finalize and start rendering. |

## Delivery guarantees

Message delivery is **incremental**. You may receive `loading` updates and `lyrics` before note/chord payloads. `tone_changes` comes after `lyrics` when present and may be omitted entirely. **Do not finalize rendering until you receive `ready`.**

## Consumer notes

- **Tuning array length follows arrangement.** 6 strings for guitar, 4 for bass, more for extended-range GP imports. Use `highway.getStringCount()` for the authoritative count rather than `tuning.length` (which can be the RS-XML padded 6-string form).
- **Chord templates are static.** Every `chord_id` referenced by `chords` is guaranteed to be present in `chord_templates`.
- **Notes carry technique fields.** `ho` = hammer-on, `po` = pull-off, `sl` = slide target, `bn` = bend amount. The full set is defined in `lib/song.py`.
- **Multiple connections are supported.** Split-screen panels, lyrics panes, and jumping-tab panes each open their own WebSocket. By design — don't try to multiplex.

## Phrase payload (slopsmith#48)

`phrases.data` is an array of phrase objects. Each phrase has `start_time`, `end_time`, `max_difficulty`, and `levels`. Each `level` has `difficulty`, `notes`, `chords`, `anchors`, `handshapes` — fully scoped to that phrase. The master-difficulty slider applies a single difficulty across all phrases by selecting the matching level.

## Related

- [PLUGIN_AUTHORING.md](PLUGIN_AUTHORING.md) — guide index
- [plugin-visualization-contracts.md](plugin-visualization-contracts.md) — bundle shape passed to `draw()`
- [sloppak-spec.md](sloppak-spec.md) — sloppak format these messages are derived from
- `lib/song.py` — server-side `Note`, `Chord`, `Arrangement`, `Song` data models
