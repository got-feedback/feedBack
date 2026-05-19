# Sloppak Format — Developer Guide

Sloppak is Slopsmith's open, hand-editable song format. This guide is for developers who want to **read**, **write**, or **extend** the format — including adding new data types like drum tabs, vocal pitches, lighting cues, key/scale annotations, or anything else a future visualization plugin might need.

> If you're a **user** wanting to modify an existing sloppak — record your own rhythm stem, fix metadata, swap cover art, replace a Demucs split — see [sloppak-hand-editing.md](sloppak-hand-editing.md). That guide is the practical, step-by-step companion to this developer reference.

The authoritative format reference lives in code (`lib/sloppak.py`, `lib/song.py`); this doc explains the why, the how, and the conventions you should follow when adding to it.

---

## 1. Format at a glance

A sloppak exists in **two interchangeable forms**:

| Form | What it is | Used for |
|---|---|---|
| **Directory** | A folder named `*.sloppak/` containing the files below | Authoring, hand editing, plugin development |
| **Zip archive** | A `.sloppak` file (zip with the same files inside) | Distribution |

Both forms hold identical contents. Slopsmith resolves either transparently — zip files are unpacked to a cache the first time they're opened (see `resolve_source_dir()` in [lib/sloppak.py](../lib/sloppak.py)).

### Directory layout

```
my-song.sloppak/
├── manifest.yaml             # Required — all metadata + file index
├── arrangements/
│   ├── lead.json             # One JSON per playable arrangement
│   ├── rhythm.json
│   └── bass.json
├── stems/
│   ├── full.ogg              # Mixed audio (initial single-stem output; may be absent after stem splitting)
│   ├── guitar.ogg            # Optional individual stems
│   ├── bass.ogg
│   ├── drums.ogg
│   ├── vocals.ogg
│   └── other.ogg
├── lyrics.json               # Optional — syllable-level lyrics
└── cover.jpg                 # Optional — album art
```

Three rules to remember:

1. **`manifest.yaml` is the index.** Nothing inside the sloppak is auto-discovered — every file path is listed in the manifest. This makes the format predictable: no scanning, no guessing. (One historical exception: the cover-art handler in `server.py` falls back to `cover.jpg` when `manifest.cover` is missing. New code should not add similar filename fallbacks.)
2. **Filenames in `manifest.yaml` are POSIX paths**, relative to the sloppak root (forward slashes, no leading `/`).
3. **YAML for the manifest, JSON for everything else.** YAML is hand-editable for users; JSON is fast-parsed and easy to round-trip in code.

---

## 2. `manifest.yaml` reference

Minimal valid manifest:

```yaml
title: "Black Hole Sun"
artist: "Soundgarden"
duration: 320.5
arrangements:
  - id: lead
    name: Lead
    file: arrangements/lead.json
    tuning: [0, 0, 0, 0, 0, 0]
    capo: 0
stems:
  - id: full
    file: stems/full.ogg
    default: true
```

Full set of currently-recognized top-level keys:

| Key | Type | Required | Description |
|---|---|---|---|
| `title` | string | yes | Song title |
| `artist` | string | yes | Artist name |
| `album` | string | no | Album |
| `year` | int | no | Release year |
| `duration` | float | yes | Song length in seconds |
| `arrangements` | list | yes | Playable arrangements (see §2.1) |
| `stems` | list | yes | Audio stems (see §2.2) |
| `stem_separation` | object | no | Structured metadata when stems were produced by an automated separation engine (currently `demucs`). Shape: `{engine, model, version}`. See §2.2 for fields + semver semantics per [slopsmith#357](https://github.com/got-feedback/feedback/issues/357). Omitted for single-stem sloppaks (`stems: [{id: full, ...}]`) and for hand-edited / user-recorded stems |
| `lyrics` | string | no | Path to lyrics JSON |
| `lyrics_source` | string | no | Where the lyrics came from: `xml` (vocals XML from the chart source), `whisperx` (auto-transcribed), or `user` (hand-edited). Absent on legacy sloppaks — readers should treat missing as `xml` |
| `lyric_transcription` | object | no | Structured metadata when lyrics came from an automated engine (currently `whisperx`). Same shape as the parent `stem_separation` block defined by [slopsmith#357](https://github.com/got-feedback/feedback/issues/357) — see §2.3 for fields and semver semantics. Omitted for authored lyrics (`xml`/`user`) |
| `vocal_pitch` | string | no | Path to per-syllable pitch JSON (`{"version": 1, "notes": [{t, d, midi}, ...]}`). Consumed by [slopsmith-plugin-lyrics-karaoke](https://github.com/got-feedback/feedback-plugin-lyrics-karaoke) to render karaoke note bars. See §2.4 |
| `pitch_extraction` | object | no | Structured metadata when pitch was extracted by an automated engine (currently `crepe` via the demucs server's `/pitch` endpoint). Same shape as `stem_separation` / `lyric_transcription`. Omitted for hand-edited pitch tracks |
| `cover` | string | no | Path to cover image |
| `preview` | string | no | Path to a short preview audio clip (OGG) at the sloppak root. Populated when the source carries a separate short browser-preview clip (decoded to `preview.ogg`); absent otherwise. Consumed by [`slopsmith-plugin-song-preview`](https://github.com/got-feedback/feedback-plugin-song-preview) for hover-to-listen previews in the library |
| `song_timeline` | string | no | Path to a `song_timeline.json` file carrying song-wide beats and sections (see §5.3). When present, its data takes priority over any beats/sections embedded in arrangement JSONs. Older readers ignore the key and fall back to reading beats/sections from the first arrangement JSON as before |
| `drum_tab` | string | no | Path to `drum_tab.json` — per-piece drum hits (see §5.3). Implemented end-to-end as of slopsmith#344 |

Unknown keys are **silently ignored** by the loader. This is deliberate — it's the extensibility hook (see §5).

### 2.1. `arrangements[]`

Each entry describes one playable arrangement and points at its JSON file:

```yaml
arrangements:
  - id: lead              # filesystem-safe stable ID, used for filenames
    name: Lead            # display name (Lead/Rhythm/Bass/Combo are sorted first)
    file: arrangements/lead.json
    tuning: [0, 0, 0, 0, 0, 0]   # six semitone offsets from E A D G B E
    capo: 0
    centOffset: 0.0              # optional float, cents; default 0.0
```

- `tuning` is a list of semitone offsets from standard `E2 A2 D2 G3 B3 E4`. **Six elements is the standard six-string convention** and the only length `lib/tunings.py` produces friendly names for; 5- and 7-string content is accepted by the loader and falls through to a numeric label. For bass, the four bass strings are at indices 0–3; the other two slots are `0`. Consumers should not hard-code `len(tuning) == 6`.
- `name` controls the sort order in the UI: `Lead > Combo > Rhythm > Bass > everything else`.
- `centOffset` is a pitch-shift value in cents. Commonly `-1200.0` for extended-range bass arrangements tuned one octave down; small non-zero values for songs mastered at a non-A440 reference pitch (e.g. A443 ≈ +11.8 cents). Absent / `0.0` means no shift. Exposed to plugins via `getSongInfo().centOffset`.
- Manifest-level `tuning`, `capo`, and `centOffset` **override** anything embedded in the arrangement JSON. The arrangement JSON's own values are fallbacks.
- `notation` (optional string) — path to a `notation_<id>.json` file carrying standard musical notation data for this arrangement (see §5.3). When present, the loader surfaces it on `LoadedSloppak.notation_by_id[id]` and the highway WS streams `notation_info` + `notation_measures` messages. The `file:` key may be omitted when `notation:` is present — the loader creates a stub arrangement so the notation file can be the sole data source.

### 2.2. `stems[]`

```yaml
stems:
  - id: full
    file: stems/full.ogg
    default: true        # plays by default when the song opens
  - id: guitar
    file: stems/guitar.ogg
    default: true
  - id: drums
    file: stems/drums.ogg
    default: false
```

- `id` is referenced by the Stems plugin and any other consumer; keep it stable.
- `default` accepts `true`/`false`, or strings (`"on"`/`"off"`/`"true"`/etc.) for hand-edited manifests.
- A freshly converted sloppak from `lib/sloppak_convert.py` starts with a single `{id: full, file: stems/full.ogg, ...}` entry. After stem-splitting (Demucs), `full.ogg` is removed and the manifest is rewritten with per-instrument entries (`guitar`, `bass`, `drums`, `vocals`, `other`). The format requires only that `stems` is non-empty — there's no specific filename or id that must always be present.

When stems were produced by an automated separation engine (Demucs), an optional `stem_separation` block records which engine + model produced them. Per [slopsmith#357](https://github.com/got-feedback/feedback/issues/357):

```yaml
stem_separation:
  engine: demucs           # stable engine id; only `demucs` today
  model: htdemucs_6s       # specific model name (htdemucs_6s / htdemucs_ft / htdemucs / mdx_extra / ...)
  version: 1.0.0           # semver for slopsmith's stem-artifact contract
```

Fields:
- `engine` — stable identifier for the separation engine. Currently always `demucs`. New engines (e.g. a hypothetical `spleeter`) would get their own stable id.
- `model` — the engine-specific model id used for this split. For Demucs this is the `-n` flag value.
- `version` — semver for Slopsmith's stem-artifact contract (independent of upstream Demucs / model versions). Bump per the same semantics #357 defines: patch = metadata-only fixes, minor = backward-compatible additions, major = stem set / packing / post-processing changed and existing splits should be regenerated.

Omitted for single-stem sloppaks (`stems: [{id: full, ...}]` — no automated separation ran) and for hand-edited / user-recorded stems. The RFC reserves a separate `stem_authoring` sibling block for the hand-edit case; that's deferred to a follow-up.

A remote Demucs server can use this block as part of a cache key so that changing the model or major version naturally produces a cache miss. Local plugin jobs should preserve this metadata in job state and in any copied/downloaded manifests.

### 2.3. `lyrics`

If present, points at a JSON file containing a flat list of syllable objects:

```json
[
  {"t": 12.34, "d": 0.18, "w": "Hel"},
  {"t": 12.52, "d": 0.22, "w": "lo-"},
  {"t": 13.10, "d": 0.30, "w": "world"}
]
```

| Field | Meaning |
|---|---|
| `t` | Time in seconds |
| `d` | Duration in seconds |
| `w` | Syllable text. Trailing `-` joins to the next syllable as one word; trailing `+` marks the last syllable of a line (renderer wraps after it). Both are suffixes on a real syllable — not standalone entries. See `static/highway.js` for the rendering: `raw.endsWith('+')` flags end-of-line, and `sylText` strips the trailing marker before drawing |

When lyrics are present, the optional top-level `lyrics_source` key records where they came from. The assembler sets it to `xml` when the lyrics were parsed from the source chart's vocals XML; the WhisperX auto-transcription fallback (`scripts/transcribe_lyrics.py`, or `--auto-lyrics` on the split scripts) sets it to `whisperx`. Hand-edited lyrics should bump it to `user` so UI consumers can render a different badge (or no badge) than for machine-generated lyrics. The key is absent on sloppaks produced before this field existed — readers should treat missing as `xml` for backward compatibility.

When `lyrics_source` is `whisperx` (or any future automated engine), an optional `lyric_transcription` block records which engine + model produced the file. Shape mirrors the parent `stem_separation` RFC ([slopsmith#357](https://github.com/got-feedback/feedback/issues/357)):

```yaml
lyric_transcription:
  engine: whisperx     # stable engine id
  model: medium        # the WhisperX model size that ran (tiny/base/small/medium/large-v2/large-v3)
  version: 1.0.0       # semver for slopsmith's lyric-transcription artifact contract
```

Fields:
- `engine` — stable identifier for the transcription engine; currently always `whisperx`.
- `model` — the engine-specific model id used for this transcription.
- `version` — semver for Slopsmith's lyric-transcription artifact contract (independent of upstream Whisper / WhisperX versions). Bump per the same semantics #357 defines for stems: patch = metadata-only fixes, minor = backward-compatible additions, major = output shape changed and existing transcriptions should be regenerated.

Omitted for authored lyrics (`xml` / `user`). A remote WhisperX server can use this block as part of a cache key the same way #357 envisions for stems — caches should miss whenever any of the three fields change, ensuring stale transcriptions don't get returned after a model bump.

### 2.4. `vocal_pitch`

If present, points at a JSON file holding per-syllable pitch data — the karaoke companion to `lyrics`. Consumed by [slopsmith-plugin-lyrics-karaoke](https://github.com/got-feedback/feedback-plugin-lyrics-karaoke) to render karaoke-style note bars over the lyric text. Shape:

```json
{
  "version": 1,
  "notes": [
    {"t": 12.34, "d": 0.40, "midi": 64},
    {"t": 12.78, "d": 0.55, "midi": 67}
  ]
}
```

| Field | Meaning |
|---|---|
| `version` | Schema version of this `vocal_pitch.json` file (currently the integer `1`). Bump on a breaking change to the `notes` entry shape. This is *not* the same as the top-level `pitch_extraction.version` block below, which is a semver string used as a cache-key for the extractor engine |
| `notes` | List of pitch entries, one per syllable that the extractor could lock onto. `t` + `d` mirror the matching `lyrics.json` entry; `midi` is the MIDI note number (60 = middle C). Syllables the extractor couldn't pitch (silent / sub-confidence) are omitted from this list — it may be shorter than `lyrics.json` |

When pitch came from an automated engine (the demucs server's `/pitch` endpoint, which runs CREPE), the optional top-level `pitch_extraction` block records which engine + model produced the file. Same shape and semver-string semantics as `stem_separation` / `lyric_transcription` — distinct from the in-file integer `version` field above:

```yaml
pitch_extraction:
  engine: crepe
  model: v1
  version: 1.0.0
```

Omitted for hand-edited pitch tracks. As with the other two automated-artifact blocks, a remote pitch server can use this for cache-key invalidation.

The sloppak assembler runs pitch extraction automatically when `pitch_extraction.enabled` is set in its config AND a server URL is configured (either `pitch_extraction.server_url` or the shared `demucs_server_url`) AND the sloppak has lyrics + a `stems/vocals.ogg` after the split pass — either because `_maybe_transcribe_lyrics` just produced them via WhisperX OR because they were already on disk (from the source chart's vocals XML, hand-authoring, or an earlier build). Pitch is *not* coupled to `whisperx.enabled` — setting `pitch_extraction.enabled=true` alone (with WhisperX off) is enough to retro-generate pitch over any existing on-disk lyrics. Sloppaks built before this field existed simply don't carry it — readers should treat missing `vocal_pitch` as "no pitch data, fall back to whatever the karaoke plugin's local-extraction path produces (if any)".

---

## 3. Arrangement JSON — the wire format

Arrangement JSON files use the **wire format** produced by `arrangement_to_wire()` — the on-disk representation of a complete arrangement. Slopsmith's `/ws/highway/{filename}` endpoint transports similar data as a sequence of typed messages (`notes`, `chords`, `anchors`, `chord_templates`, `phrases`, …) rather than as one identical top-level JSON object. In practice, the WebSocket stream reuses the same per-object field names where applicable, but it should not be treated as a byte-for-byte match for `arrangements/*.json`.

The authoritative serializer/deserializer is in [lib/song.py](../lib/song.py):

- `arrangement_to_wire(arr) → dict` — write
- `arrangement_from_wire(dict) → Arrangement` — read

### 3.1. Top-level shape

```json
{
  "name": "Lead",
  "tuning": [0, 0, 0, 0, 0, 0],
  "capo": 0,
  "centOffset": 0.0,            /* optional, float cents, default 0.0 */
  "notes":      [ /* see 3.2 */ ],
  "chords":     [ /* see 3.3 */ ],
  "anchors":    [ /* see 3.4 */ ],
  "handshapes": [ /* see 3.5 */ ],
  "templates":  [ /* see 3.6 */ ],
  "phrases":    [ /* optional, see 3.7 */ ],
  "tones":      { /* optional, see 3.9 */ },
  "beats":      [ /* see 3.8, only on first arrangement */ ],
  "sections":   [ /* see 3.8, only on first arrangement */ ]
}
```

`beats` and `sections` are **song-level** but live on the first arrangement's JSON for legacy reasons — `lib/sloppak.py` hoists them to the `Song` object on load. If you author multiple arrangements, only put them in one file. **New sloppaks should use `song_timeline.json` instead** (see §2 and §5.3) — when the manifest carries a `song_timeline:` key pointing at a schema-valid file, its beats/sections **replace** whatever the arrangement JSONs loaded (the override is applied after arrangement loading, so a valid `song_timeline.json` always wins). Arrangement-JSON beats/sections remain supported for backward compatibility with all existing sloppaks and are the fallback when the file is absent or invalid.

### 3.2. Notes

Field names are short on purpose — these get streamed thousands of times per song. Don't expand them.

```json
{
  "t": 12.345,    // time (s)
  "s": 2,         // string (0 = lowest)
  "f": 7,         // fret (0 = open, 24 = max)
  "sus": 0.5,     // sustain (s, 0 = none)
  "sl": 9,        // pitched slide-to fret (-1 = no slide)
  "slu": -1,      // unpitched slide-to fret (-1 = no slide)
  "bn": 1.0,      // bend amount in semitones
  "ho": false,    // hammer-on
  "po": false,    // pull-off
  "hm": false,    // natural harmonic
  "hp": false,    // pinch harmonic
  "pm": false,    // palm mute
  "mt": false,    // string mute
  "vb": false,    // vibrato
  "tr": false,    // tremolo
  "ac": false,    // accent
  "tp": false,    // tap
  "ln": false,    // link-next (chord linking metadata; renderers may ignore — runtime linking is derived from proximity)
  "fhm": false,   // fret-hand mute
  "plk": false,   // pluck (pop, bass)
  "slp": false,   // slap (bass)
  "rh": -1,       // right-hand fingering (-1 = unset)
  "pkd": -1,      // pick direction (-1 = unset, 0 = down, 1 = up)
  "ig": false     // ignore (chart-author flag — note is rendered but not scored / sequenced)
}
```

Default values: numbers → `0` or `-1` (slides / `rh` / `pkd`), bools → `false`. Omit fields equal to their default if you're authoring by hand — the parser fills them in. **Encoders should default-omit the newer technique keys** (`ln`, `fhm`, `plk`, `slp`, `rh`, `pkd`, `ig`) — the highway streams notes thousands of times per song, so trimming the common case keeps the WebSocket payload tight. The pre-existing keys are still emitted unconditionally to preserve the legacy wire contract.

### 3.3. Chords

A chord groups note-shaped objects under a single time:

```json
{
  "t": 30.0,
  "id": 12,           // index into templates[]
  "hd": false,        // high-density flag
  "notes": [
    {"s": 0, "f": 3, "sus": 0.0, ...},
    {"s": 1, "f": 5, "sus": 0.0, ...}
  ]
}
```

Chord notes use the same field set as standalone notes, **except `t` is omitted** (the chord carries the time). The fingering / shape lookup is `chord.id → templates[id]`.

### 3.4. Anchors

Where the fretting hand sits. Drives the highway zoom box.

```json
{"time": 12.0, "fret": 5, "width": 4}
```

### 3.5. Hand shapes

Spans during which a chord shape is held:

```json
{"chord_id": 12, "start_time": 30.0, "end_time": 31.5, "arp": false}
```

- `chord_id` (`int`, default `0`) — index into `templates[]`; identifies which chord template the span is holding.
- `start_time` (`float`, default `0.0`) — start of the span in seconds.
- `end_time` (`float`, default `0.0`) — end of the span in seconds.
- `arp` (`bool`, default `false`, allowed values `true`/`false`) — whether this hand shape should be treated as an arpeggio span rather than a fully-strummed chord hold.

### 3.6. Chord templates

Named shapes referenced by `chord.id` and `handshape.chord_id`:

```json
{
  "name": "Em7",
  "displayName": "Em7",
  "arp": false,
  "fingers": [-1,  2,  1, -1, -1, -1],
  "frets":   [ 0,  2,  2,  0,  0,  0]
}
```

- `name` (`string`, default `""`) — canonical template name used by the parser / authoring data.
- `displayName` (`string`, default `name`) — label shown in the UI; source XML may use this for display-specific variants such as `-arp`.
- `arp` (`bool`, default `false`, allowed values `true`/`false`) — whether the template is flagged as arpeggiated. Parsed from explicit XML attributes (`arpeggio` / `arp`, any common casing) or inferred from `displayName` markers such as `-arp`.
- `fingers` (`int[6]`, default `[-1, -1, -1, -1, -1, -1]`) — fretting-hand finger numbers, lowest string first. `-1` = unused string, `0` = open string / no fretting finger, `1..4` = index/middle/ring/pinky.
- `frets` (`int[6]`, default `[-1, -1, -1, -1, -1, -1]`) — fret numbers, lowest string first. `-1` = unused string, `0` = open string, positive values = fretted note.

### 3.7. Phrases (optional, multi-difficulty data)

Sources that carry per-phrase difficulty ladders (phrase-aware arrangement XML) include this. GP imports and legacy sloppaks omit it:

```json
"phrases": [
  {
    "start_time": 0.0,
    "end_time":   12.5,
    "max_difficulty": 4,
    "levels": [
      { "difficulty": 0, "notes": [...], "chords": [...], "anchors": [...], "handshapes": [...] },
      { "difficulty": 1, "notes": [...], "chords": [...], "anchors": [...], "handshapes": [...] },
      ...
    ]
  }
]
```

If you're writing a converter that doesn't have multi-difficulty data, **omit the `phrases` key entirely** (don't emit `"phrases": []`). A missing key signals "no ladder, disable the master-difficulty slider"; an empty list is the same in current code but reads ambiguously.

### 3.8. Beats and sections

```json
"beats":    [{"time": 0.5, "measure": 1}, {"time": 1.0, "measure": -1}, ...],
"sections": [{"name": "verse", "number": 1, "time": 12.5}, ...]
```

`measure: -1` = sub-beat (not a downbeat). Section `name` follows the usual song-structure conventions (`intro`, `verse`, `chorus`, `bridge`, `solo`, `outro`, …).

### 3.9. Tones (optional)

`tones` carries the arrangement's guitar tones — the amp/pedal/cabinet gear and the in-song tone switches. It's populated when the source chart carries tone data (`lib/tones.py`); a sloppak authored from scratch may omit it entirely.

```json
"tones": {
  "base": "Clean Rhythm",
  "changes": [
    {"t": 12.5, "name": "Lead Drive"},
    {"t": 48.0, "name": "Clean Rhythm"}
  ],
  "definitions": [
    {
      "Name": "Clean Rhythm",
      "Key": "Tone_A",
      "GearList": { /* raw gear blocks: Amp, PrePedal1-4, … */ }
    }
  ]
}
```

- `base` (string) — the tone in effect before the first change.
- `changes` (list, time-sorted) — `{"t": seconds, "name": str}` tone switches. The highway draws a marker at each. Omit when the arrangement never switches tone.
- `definitions` (list) — the **raw tone objects** (`Name`, `Key`, `GearList`), copied verbatim from the source chart's tone manifest. The Tones plugin parses these into the rendered signal chain (it owns the gear-name/image map, so the data is stored unparsed here).

All three sub-keys are individually optional; an arrangement with none of them simply omits `tones`. Readers that don't know about tones ignore the key (the loader preserves it verbatim).

---

## 4. Reading and writing sloppaks programmatically

### 4.1. Reading (Python, server-side)

```python
from pathlib import Path
from sloppak import load_song, load_manifest

# Quick metadata only (parses manifest, skips arrangement JSONs)
manifest = load_manifest(Path("song.sloppak"))

# Full song load (manifest + all arrangements + lyrics)
loaded = load_song("song.sloppak", dlc_root=Path("/dlc"), unpack_cache_root=Path("/cache"))
print(loaded.song.title, len(loaded.song.arrangements))
print(loaded.stems)        # [{"id": "full", "file": "stems/full.ogg", "default": True}]
print(loaded.manifest)     # raw dict — read your custom keys here
```

### 4.2. Writing (Python, server-side)

There's no general-purpose writer in `lib/` yet. The current writer lives in [lib/sloppak_convert.py](../lib/sloppak_convert.py) inside the sloppak assembly function — it's the single source of truth for "how a sloppak gets built." If you need to write sloppaks from a new source, copy the structure of that function:

1. Build a `work_dir/` in temp.
2. Write `arrangements/{id}.json` per arrangement using `arrangement_to_wire()`.
3. Encode audio to OGG into `stems/`.
4. Optionally write `lyrics.json`, `cover.jpg`.
5. Compose the `manifest` dict and dump as YAML with `yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True)`.
6. Either `shutil.copytree(work_dir, out)` for directory form, or `_zip_dir(work_dir, out)` for zip form.

Always use `yaml.safe_dump` (not `yaml.dump`) and pass `sort_keys=False` so the human-readable order is preserved.

### 4.3. Reading (JavaScript, plugin-side)

Plugins typically don't read the sloppak file directly — they consume the `/ws/highway/{filename}` WebSocket stream (see [`websocket-protocol.md`](websocket-protocol.md) for the message protocol), which produces the same shapes. If you specifically need raw manifest access from the browser, expose it through a custom backend route in your plugin's `routes.py` and fetch it.

---

## 5. Extending the format — adding new data

Sloppak is designed to be extended without breaking older readers. The conventions below come from how `lyrics`, `stems`, and the optional `phrases` ladder were each added.

### 5.1. The golden rule: **manifest opt-in, file off to the side**

New data types should follow this pattern:

1. **Drop a new file** alongside the standard ones (e.g., `drums.json`, `keys.json`, `lighting.json`).
2. **Add a manifest key** that *points at* that file (e.g., `drum_tab: drums.json`).
3. **Make consumers gate on the manifest key**: if the key is absent, do nothing. Never auto-discover by filename — that breaks the "manifest is the index" rule.

So a sloppak with drum tabs would look like:

```yaml
# manifest.yaml
title: "Song"
artist: "Band"
duration: 240.0
arrangements: [...]
stems: [...]
drum_tab: drum_tab.json     # ← new key
```

```
my-song.sloppak/
├── manifest.yaml
├── arrangements/...
├── stems/...
└── drum_tab.json           # ← new file
```

Older Slopsmith readers ignore the unknown `drum_tab` key (the loader uses `manifest.get("drum_tab")` / unknown keys pass through). Your plugin checks for it and renders accordingly. **Zero coordination needed with core.**

### 5.2. Naming conventions for new keys and files

- **Manifest keys**: `snake_case`, descriptive, singular when the value is one thing (`lyrics`, `cover`, `drum_tab`), plural when it's a list (`stems`, `arrangements`).
- **File names**: lowercase, hyphenated or underscored, JSON for structured data, OGG for audio, JPG/PNG for images.
- **Inside JSON**: short field names for hot-path data that gets streamed thousands of times (`t`, `s`, `f` — see §3.2). Long names are fine for one-off metadata.
- **Time fields**: always `t` or `time` (not `start`, not `timestamp`) — and always **seconds as floats**, not ms or ticks. Be consistent with the existing wire format.
- **Indexes / IDs**: stable, filesystem-safe, lowercase. Don't reuse a source format's internal numeric IDs unless you have to.

### 5.3. Worked examples for the kinds of additions you mentioned

#### Drum tab

`drum_tab.json` carries per-piece hits authored on top of the song's audio.
Implemented end-to-end as of slopsmith#344 (drums-from-scratch): the loader
in `lib/sloppak.py` parses it, `lib/drums.py` defines the canonical piece-id
vocabulary, and `/ws/highway/{filename}` streams it as `drum_tab` + chunked
`drum_hits` messages.

```json
{
  "version": 1,
  "name": "Drums",
  "kit": [
    {"id": "kick",      "name": "Kick"},
    {"id": "snare",     "name": "Snare"},
    {"id": "hh_closed", "name": "Hi-hat (closed)"},
    {"id": "hh_open",   "name": "Hi-hat (open)"},
    {"id": "crash_r",   "name": "Crash (right)"},
    {"id": "ride",      "name": "Ride"}
  ],
  "hits": [
    {"t": 0.500, "p": "kick",      "v": 110},
    {"t": 0.750, "p": "snare",     "v":  92},
    {"t": 0.750, "p": "hh_closed", "v":  70},
    {"t": 1.000, "p": "snare",     "v":  60, "g": true},
    {"t": 1.250, "p": "snare",     "v": 105, "f": true},
    {"t": 4.000, "p": "crash_r",   "v": 120, "k": 0.080}
  ]
}
```

Manifest:

```yaml
drum_tab: drum_tab.json
```

##### Hit fields

| key | type | meaning |
| --- | --- | --- |
| `t` | float seconds | hit time, required, monotonic in `hits[]` |
| `p` | string | piece-id from the closed list below; required |
| `v` | int 1-127 | velocity (default 100) |
| `g` | bool | ghost note (renders smaller / outline-only) |
| `f` | bool | flam (renders a small leading ghost glyph 30 ms early) |
| `k` | float seconds | cymbal-choke tail duration (renders a fade-out) |

##### Canonical piece-id vocabulary

A closed list lives in `lib/drums.py::PIECES`. Open/closed hi-hat are
**distinct piece-ids**, not articulation flags — hit detection must reject
a closed-hat strike on an open-hat note, which it can only do if the
articulation is part of the piece-id.

| piece-id | category | default GM MIDI | default shape |
| --- | --- | --- | --- |
| `kick` | kick | 35, 36 | bar (full-width across all non-kick lanes) |
| `snare` | drum | 38, 40 | rectangle |
| `snare_xstick` | drum | 37 | hatched rectangle |
| `tom_hi` | drum | 50, 48 | rectangle |
| `tom_mid` | drum | 47, 45 | rectangle |
| `tom_low` | drum | 43 | rectangle |
| `tom_floor` | drum | 41 | rectangle |
| `hh_closed` | cymbal | 42 | filled circle |
| `hh_open` | cymbal | 46 | ring (outline) circle |
| `hh_pedal` | cymbal | 44 | small circle with × |
| `stack` | cymbal | 30 | jagged circle (no GM standard — reuses 30 from extended-percussion range) |
| `crash_l` | cymbal | 49 | circle |
| `crash_r` | cymbal | 57 | circle |
| `splash` | cymbal | 55 | small circle |
| `china` | cymbal | 52 | jagged circle |
| `ride` | cymbal | 51, 59 | circle |
| `ride_bell` | cymbal | 53 | circle with centre dot |
| `bell` | cymbal | 80 | circle with centre dot (no GM standard — reuses "Mute Triangle") |

Unknown piece-ids round-trip through the loader (forward-compat); the
client just renders them as a default rectangle.

##### Wire format

Streamed as two highway-WS message types:

```json
{ "type": "drum_tab", "version": 1, "name": "Drums",
  "kit": [{"id": "kick", "name": "Kick"}, ...], "total": 1234 }
```

…followed by one or more chunks of 500 hits:

```json
{ "type": "drum_hits", "data": [{"t": 0.5, "p": "kick", "v": 110}, ...],
  "total": 1234 }
```

##### Design notes

- `kit[]` is the legend — fixed metadata, separated from hot-path data.
- `hits[]` uses short field names because this list can be thousands long.
- `v` defaults to 100; ghost / flam / choke flags are all optional.
- Older sloppaks whose drums are encoded as guitar notes (`midi = string*24 + fret`) still play — the drums plugin keeps a legacy decoder that reads the standard `notes` stream and synthesises `drum_hits` from it.

#### Song timeline (beats and sections as a top-level file)

`song_timeline.json` moves song-wide beats and sections out of the first
arrangement JSON and into a dedicated file. Implemented in `lib/sloppak.py`
alongside the notation format: the loader reads the manifest's optional
`song_timeline:` key, validates the file, and populates `Song.beats` /
`Song.sections` from it, taking priority over any beats/sections embedded
in arrangement JSONs.

```json
{
  "version": 1,
  "beats": [
    {"time": 0.500, "measure": 1},
    {"time": 1.000, "measure": -1},
    {"time": 1.500, "measure": -1},
    {"time": 2.000, "measure": 2}
  ],
  "sections": [
    {"name": "intro",  "number": 1, "time": 0.0},
    {"name": "verse",  "number": 1, "time": 16.0},
    {"name": "chorus", "number": 1, "time": 32.0}
  ]
}
```

Manifest:

```yaml
song_timeline: song_timeline.json
```

| Field in `beats[]` | Type | Notes |
|---|---|---|
| `time` | float seconds | Beat timestamp. Matches the existing arrangement-JSON wire convention |
| `measure` | int | 1-based downbeat number. `-1` = sub-beat (not a downbeat) |

| Field in `sections[]` | Type | Notes |
|---|---|---|
| `name` | string | song-structure convention: `intro`, `verse`, `chorus`, `bridge`, `solo`, `outro`, … |
| `number` | int | Section repeat number |
| `time` | float seconds | Section start |

**Backward compatibility.** Sloppaks without `song_timeline:` continue to
work — the loader falls through to reading beats/sections from the first
arrangement JSON exactly as before. No migration is needed.

**New sloppaks** should put beats/sections here and leave arrangement JSONs
free of timeline data. This is especially important for notation-only
arrangements (see below) where there may be no arrangement JSON at all.

---

#### Notation format (standard musical notation per arrangement)

The notation format promotes keys, piano, violin, and any other
staff-notation instrument to first-class status with their own data
structure, separate from the guitar wire format. Implemented in
`lib/sloppak.py` and `lib/notation.py`; the highway WS streams
`notation_info` + `notation_measures` messages when notation data is
present for the active arrangement.

**Architecture: per-arrangement, not song-wide.** Unlike `drum_tab`
(one drum track per song, top-level manifest key), notation is
per-instrument. A song could carry both `notation_keys.json` and
`notation_violin.json`. The manifest key lives on the **arrangement
entry**, not at the top level.

```yaml
arrangements:
  - id: keys
    name: Keys
    type: piano
    notation: notation_keys.json   # per-arrangement sub-key
    # file: is optional when notation: is present
```

```text
my-song.sloppak/
├── manifest.yaml
├── song_timeline.json
├── notation_keys.json
└── stems/
    └── full.ogg
```

**`notation_<id>.json` — file schema:**

```json
{
  "version": 1,
  "instrument": "piano",
  "staves": [
    {"id": "rh", "clef": "G2", "label": "Right Hand"},
    {"id": "lh", "clef": "F4", "label": "Left Hand"}
  ],
  "measures": [
    {
      "idx": 1,
      "t": 0.0,
      "ts": [4, 4],
      "ks": 0,
      "tempo": 120.0,
      "staves": {
        "rh": {
          "voices": [{"v": 1, "beats": [
            {"t": 0.000, "dur": 4, "notes": [{"midi": 64}]},
            {"t": 0.500, "dur": 4, "notes": [{"midi": 67}]}
          ]}]
        },
        "lh": {
          "voices": [{"v": 1, "beats": [
            {"t": 0.000, "dur": 1, "notes": [{"midi": 52}, {"midi": 60}]}
          ]}]
        }
      }
    }
  ]
}
```

**Top-level fields:**

| Field | Type | Notes |
|---|---|---|
| `version` | int | Always `1`. Bump on breaking schema change |
| `instrument` | string | Mirrors arrangement `type`: `piano`, `violin`, `guitar`, etc. Makes the file self-describing |
| `rights` | string | Optional copyright / rights text (MusicXML `<rights>`). Omit when absent |
| `lyricist` | string | Optional lyricist credit (MusicXML `<creator type="lyricist">`). Omit when absent |
| `arranger` | string | Optional arranger credit (MusicXML `<creator type="arranger">`). Omit when absent |
| `staves` | list | Static staff definitions. Each has `id` (stable, referenced by `measures[].staves` keys), `clef` (see below), and optional `label` |
| `measures` | list | Ordered measure data — the hot path |

**Clef vocabulary** (defined in `lib/notation.py::CLEFS`):

| Value | Meaning |
|---|---|
| `G2` | Treble clef — guitar, violin, flute, piano RH |
| `F4` | Bass clef — bass guitar, cello, piano LH |
| `C3` | Alto clef — viola |
| `C4` | Tenor clef — cello upper register, trombone |
| `neutral` | Unpitched / percussion staff |

**Measure fields:**

| Field | Type | Notes |
|---|---|---|
| `idx` | int | 1-based measure number |
| `t` | float | Time in seconds at measure downbeat |
| `ts` | int[2] | Time signature `[numerator, denominator]`. Omit if unchanged |
| `beat_groups` | int[] | Beat grouping for compound and irregular meters, as a list of integers. Each integer is the count of time-signature denominator units in that primary beat group. The sum must equal the time-signature numerator. E.g. 6/8 → `[3, 3]`; 9/8 → `[3, 3, 3]`; 7/8 → `[2, 2, 3]`; 5/8 → `[2, 3]` or `[3, 2]`. Omit for simple meters (2/4, 3/4, 4/4) where grouping is unambiguous. Renderers translate this to their own beam-grouping API at render time — this field is renderer-agnostic. |
| `ks` | int | Key signature: semitones from C, −7 to +7 (negative = flats, positive = sharps). Omit if unchanged |
| `tempo` | float | BPM. Omit if unchanged |
| `pickup` | bool | `true` when this measure is an anacrusis (pickup / upbeat) shorter than the time signature implies (MusicXML `implicit="yes"`). Renderers suppress the measure number and start counting from the next full measure. Omit when false |
| `staves` | object | Keyed by staff `id`. Each staff has optional `clef` (omit if unchanged) and `voices` |

**Beat fields** (inside `staves → voices → beats`):

| Field | Default | Notes |
|---|---|---|
| `t` | required | Time in seconds |
| `dur` | required | Duration denominator: `1`=whole, `2`=half, `4`=quarter, `8`=eighth, `16`=sixteenth, `32`=thirty-second |
| `dot` | omit | Augmentation dots: `1`=dotted, `2`=double-dotted |
| `rest` | omit | `true` if this beat is a rest; `notes` is omitted |
| `tu` | omit | Tuplet: `[numerator, denominator]`, e.g. `[3, 2]` for triplet |
| `beat_pos` | omit | Exact position within the measure as a rational `[numerator, denominator]` pair, where the denominator is the time-signature denominator. E.g. beat 2 in 6/8 (the second dotted quarter) = `[3, 8]`. Avoids floating-point imprecision when deriving beat position from tempo and absolute time. Omit if not set by the importer. Renderers that do not recognise this field derive position from `t` and the tempo map as before. |
| `notes` | omit | List of note objects (omit for rests) |
| `dyn` | omit | Dynamic: `ppp`, `pp`, `p`, `mp`, `mf`, `f`, `ff`, `fff` |
| `slr` | omit | Slur start |
| `slre` | omit | Slur end |
| `grace` | omit | Grace-note beat, typed: `"a"` = acciaccatura (slashed, steals time from the previous note; MusicXML `<grace slash="yes">`), `"p"` = appoggiatura (unslashed, steals time from the following note; `<grace>`). The beat's `dur` is the grace note's written duration. Vocabulary in `lib/notation.py::GRACE_TYPES` |
| `arp` | omit | `true` when the beat's chord is arpeggiated (rolled; MusicXML `<arpeggiate>`) |
| `ferm` | omit | `true` when the beat carries a fermata (MusicXML `<fermata>`) |
| `spd` / `sph` / `spu` | omit | Sustain pedal: pedal **d**own / **h**old-through-this-beat / **u**p. This is the only pedal encoding — there is deliberately no separate `ped` field. MusicXML mapping: `<pedal type="start">` → `spd`, `<pedal type="change">` → `spu` + `spd` on the same beat (re-pedal), `<pedal type="stop">` → `spu`; beats inside an active pedal span carry `sph` |
| Additional beat effects | omit | `cre`, `dec`, `vib`, `vibw`, `fade`, `pm`, `lr`, `slap`, `pop`, `tap`, `su`, `sd`, `rasg`, `golpe`, `wah`, `txt`, `chrd` — all optional, omit when absent |

**Note fields** (inside `beats → notes`):

| Field | Default | Notes |
|---|---|---|
| `midi` | required | MIDI pitch 0–127. Unambiguous — no string/fret/tuning indirection |
| `tied` | omit | Tied from the previous beat |
| `acc` | omit | Accidental override: `null`/omit = derive from key sig; `0` = force natural (♮); `−2`/`−1`/`1`/`2` = double-flat/flat/sharp/double-sharp |
| `stem` | omit | Force stem direction: `"up"` or `"down"` (MusicXML `<stem>`). Omit to let the renderer decide. Vocabulary in `lib/notation.py::STEM_DIRECTIONS` |
| Additional note effects | omit | `stc`, `ten`, `ac`, `hac`, `vib`, `vibw`, `dead`, `ghost`, `fng`, `rfng`, `str`, `harm`, `bend`, `slide`, `trill`, `ho`, `po`, `tp`, `barre` — all optional |

**Wire format.** `song_info` carries `has_notation: bool`. Notation data
is streamed as two highway-WS message types after `sections`, before `anchors`:

```json
{"type": "notation_info", "version": 1, "instrument": "piano",
 "staves": [...], "total": 64}
```

…followed by one or more chunks of 32 measures:

```json
{"type": "notation_measures", "data": [...], "total": 64}
```

`total` is the measure count across **all** chunks. Clients accumulate `data` arrays until the accumulated measure count reaches `total` (an individual chunk's `data.length` says nothing — every full chunk of a multi-chunk stream is shorter than `total`). The `anchors` frame that follows the notation block is a secondary end-of-block signal.

**`lib/notation.py`** is the vocabulary library: `SCHEMA_VERSION`, `CLEFS`, `DURATIONS`, `validate_notation()`, `measure_to_wire()`, `measures_to_wire()`.

**Legacy fallback.** Sloppaks that carry keys as guitar wire format (Clone Hero converted content) continue to work — the notation plugin checks for the `notation` key on the arrangement entry. When absent, it falls back to decoding guitar wire format notes via `midi = s * 24 + f`.

**v1 non-features (accepted limitations).** The following are deliberately
out of schema v1; they ship, if ever, as **additive v1.x patches** (new
optional fields old consumers ignore — the permissive validator passes
unknown fields through by design):

- Microtonal pitch (anything finer than the ±2 semitone `acc` vocabulary).
- Figured bass.
- Mid-measure key-signature, time-signature, or clef changes (all three are
  measure-granular in v1).
- Ottava lines (`ott`), repeat/volta barline semantics (`barline`),
  ornaments beyond trills (mordents, turns), tremolo (`trem`), and notated
  glissando lines (`glis`).

Importers MUST drop these source features with a logged warning rather than
approximate them into wrong notation; renderers MUST NOT invent semantics
for field names from this list before a v1.x patch specifies them.

---

#### Key / scale annotations (for theory-aware visualizations)

`keys.json` mirroring the `sections[]` shape:

```json
{
  "version": 1,
  "events": [
    {"t":   0.0, "key": "Em",     "scale": "natural_minor"},
    {"t":  64.5, "key": "G",      "scale": "major"},
    {"t": 142.0, "key": "Em",     "scale": "natural_minor"}
  ]
}
```

Manifest:

```yaml
keys: keys.json
```

Each entry implicitly applies until the next event. Same model as `sections[]`.

#### Vocal pitch contour (a different shape, a different key)

The canonical `vocal_pitch` key + file (defined in §2.4) is the
per-syllable note format consumed by the karaoke plugin —
`{version: 1, notes: [{t, d, midi}]}`. If you want to ship a finer-
grained pitch *contour* (one sample every 20 ms, Hz instead of MIDI),
that's a different shape and should ride on its own manifest key so
the two don't collide:

```yaml
vocal_pitch_contour: vocal_pitch_contour.json
```

```json
{
  "version": 1,
  "samples": [
    {"t": 0.000, "hz": 220.5},
    {"t": 0.020, "hz": 222.1}
  ]
}
```

Per §5.1, manifest keys are cheap — reach for a new one when the
schema diverges, don't overload an existing key with a second shape.

### 5.4. `version` field — always include it

Every new file should have `"version": 1` at the top. It's free insurance: when you change the schema later, `version: 2` consumers can branch on it. Old consumers without that branch ignore the file (or fall back gracefully).

### 5.5. Stay backward-compatible

If you change a field that already shipped:

- **Adding fields** is always safe (older readers ignore them).
- **Removing fields** breaks older readers. Don't.
- **Repurposing fields** (changing meaning or units) is the worst — bump `version` and branch.

If you're tempted to remove or repurpose: leave the old field, add a new one, and sunset the old one over a release or two.

### 5.6. When to put data inside an arrangement vs. its own file

- **Inside arrangement JSON** (`arrangements/lead.json`):
  - Data that is *per-arrangement* and *per-instrument* (notes, chords, anchors, hand-shapes — guitar specifics).
  - Data that meaningfully differs between Lead and Rhythm versions of the same song.
- **Its own file** (and pointed-at via manifest key):
  - Data that is *song-wide* (lyrics, beats, sections, tempo map, drum tab, lighting, key/scale changes).
  - Data that may be authored or generated independently of the playable arrangement (a stem split, an AI-generated drum tab).

Beats and sections historically lived inside the first arrangement JSON (early arrangement XML put them there). The `song_timeline.json` file (see §5.3) is the correct home for new sloppaks — the loader reads it first and it takes priority. New song-wide data should always be its own file.

### 5.7. Don't break the manifest contract

A few things that should *not* end up in `manifest.yaml`:

- **Per-machine settings** (DMX universes, IPs, output device picks) — those go in `${CONFIG_DIR}/...json`, not the sloppak.
- **UI state** (last zoom level, panel sizes) — `localStorage` only.
- **User progress / play counts** — Slopsmith stores these in its metadata DB, not in the sloppak.

The sloppak holds **the song's authored data**. Anything that varies by user or by machine is out.

---

## 6. Quick reference — file types you'll touch

| File | Format | Schema lives in | Authority |
|---|---|---|---|
| `manifest.yaml` | YAML | `lib/sloppak.py` (`load_manifest`, `extract_meta`) | This doc + the loader |
| `arrangements/*.json` | JSON | `lib/song.py` (`arrangement_to_wire`, `arrangement_from_wire`) | The wire-format functions |
| `lyrics.json` | JSON (flat list) | `lib/sloppak.py` (passed through to `Song.lyrics`) | This doc §2.3 |
| `song_timeline.json` | JSON | `lib/sloppak.py` (loader) | This doc §5.3 |
| `notation_<id>.json` | JSON | `lib/notation.py` (`validate_notation`, `measures_to_wire`) | This doc §5.3 |
| `stems/*.ogg` | OGG Vorbis | — | Convention: `q:a 5` for size/quality balance |
| `cover.jpg` | JPEG | — | Convention: square, 500–1500 px on a side |
| Your new file | JSON (preferred) | Your plugin's spec doc | You |

---

## 7. Testing your extension

If you add a new file type or manifest key:

1. **Round-trip test**: write a sample, load it, write it back, compare. Add to `tests/test_sloppak.py`.
2. **Backward-compat test**: load a sloppak that *doesn't* have your new key — your code must not crash, and the song must still play.
3. **Hand-edit test**: open the directory form in a text editor, change a field by hand, reload Slopsmith. The format is meant to be hand-editable; your additions should preserve that.
4. **Both forms**: test with both the directory form and the zipped form. The unpack cache is invalidated based on mtime and size, so you can repackage and reload without restarting the server.

The full pytest suite (`pytest`) must stay green before any PR.

---

## 8. Where to look in the code

| For… | Read |
|---|---|
| Format detection, source resolution, zip unpacking | [lib/sloppak.py](../lib/sloppak.py) |
| Data classes (`Note`, `Chord`, `Arrangement`, `Song`, `Phrase`) | [lib/song.py](../lib/song.py) |
| Wire-format helpers (`*_to_wire` / `*_from_wire`) | [lib/song.py](../lib/song.py) |
| The reference sloppak writer | [lib/sloppak_convert.py](../lib/sloppak_convert.py) |
| Drum tab vocabulary and wire helpers | [lib/drums.py](../lib/drums.py) |
| Notation vocabulary and wire helpers | [lib/notation.py](../lib/notation.py) |
| Live streaming over WebSocket (consumes the same shapes) | `server.py` (`/ws/highway/{filename}`) |
| The plugin system (where new viz consumers go) | [docs/PLUGIN_AUTHORING.md](PLUGIN_AUTHORING.md) + [docs/plugin-visualization-contracts.md](plugin-visualization-contracts.md) |
| Tests | [tests/test_sloppak.py](../tests/test_sloppak.py), [tests/test_sloppak_convert.py](../tests/test_sloppak_convert.py) |
