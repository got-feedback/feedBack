# Sloppak Hand-Editing — User Guide

A `.sloppak` is just a zip of plain files: some YAML, some JSON, some OGG audio, maybe a JPEG. That means you can open one up and change it. Want to record your own rhythm guitar take and use that instead of the mix? Fix an artist typo? Swap the cover art? Replace a Demucs split that bled drums into the "other" stem? You don't need to rebuild the whole sloppak from its source — just edit the file.

This guide walks through the most common edits, aimed at musicians who are comfortable with a text editor and Audacity but don't live on the command line.

> For the format **schema** (what every field means, how the wire format works, how to extend the format with new data types), see the authoritative [feedpak spec](https://github.com/got-feedback/feedpak-spec/blob/main/spec/feedpak-v1.md) (the local [sloppak-spec.md](sloppak-spec.md) is now a pointer to it). This document is the **how-do-I-actually-edit-mine** companion.

---

## 1. The two forms — directory and zip

A sloppak exists in two interchangeable forms:

| Form | What it is | When to use it |
|---|---|---|
| **Directory** | A folder named `something.sloppak/` with the files loose inside | **Authoring** — easy to edit, no zip/unzip cycle |
| **Zip** | A `something.sloppak` file (zip with the same files inside) | **Distributing** — single file to share |

FeedBack reads both. You can drop either one straight into your DLC folder and it'll show up in the library.

### Unzipping for editing

FeedBack's converter ships sloppaks in zip form. To edit one, unzip it:

- **Windows:** rename `mysong.sloppak` → `mysong.zip`, right-click → Extract All. Then rename the resulting folder back to `mysong.sloppak/` (with the trailing slash / folder form). Or use [7-Zip](https://www.7-zip.org/) and unzip without renaming.
- **macOS:** rename `.sloppak` → `.zip`, double-click. Or use The Unarchiver.
- **Linux:** `unzip mysong.sloppak -d mysong.sloppak/`.

Once you have the directory form, you can edit any file inside and FeedBack will pick it up — no re-zipping required for your own use.

### Cache: when changes don't appear

The first time FeedBack opens a zip-form sloppak, it extracts a working copy into its config directory's cache: `${CONFIG_DIR}/sloppak_cache/<safe-id>` (in the standard Docker setup that's inside the `feedBack-config` volume, mounted at `/config` in the container). The `<safe-id>` is the sloppak filename with each path separator (`/` or `\`) replaced by `__` and each space replaced by `_`. So `My-Song.sloppak` stays `My-Song.sloppak`, and `Artist/My Song.sloppak` becomes `Artist__My_Song.sloppak`.

You almost never need to touch this cache directly. If you edit the **original zip** in your DLC folder, FeedBack re-extracts automatically when the zip's modification time or size changes — just save your edits and reload.

If a change still isn't appearing, the simplest reset is to remove the matching cache folder so FeedBack rebuilds it on the next song load. In a default Docker install that's `docker exec <container> rm -rf /config/sloppak_cache/<safe-id>` (or the equivalent for your setup).

If you'd rather skip the cache layer entirely, **drop the directory form straight into your DLC folder** — FeedBack uses it in place and there's nothing to invalidate.

---

## 2. Record and add your own rhythm stem

The use case: the converted rhythm guitar sounds muddy (Demucs has a tough time isolating fingerpicked acoustic, hi-gain palm mutes, etc.), and you'd rather play and record your own take.

### Step 1 — Set up your reference

1. Unzip the sloppak (see §1).
2. Look in `stems/` and open the reference audio in [Audacity](https://www.audacityteam.org/) (File → Open). Two cases:
   - **`stems/full.ogg` is present** (pre-Demucs-split sloppak, or one where you kept `full.ogg` as a fallback — see §3). Open it directly; it's the original mixed audio.
   - **No `full.ogg`, only per-instrument stems** (`guitar.ogg`, `bass.ogg`, `drums.ogg`, …). This is the default after Demucs splitting, since the converter deletes `full.ogg` once split stems exist. Select **all** the per-instrument stems and open them together — Audacity loads each as its own track aligned at `t=0`, and playing all of them at once reconstructs the full mix.
3. Note the **sample rate** displayed in Audacity's status bar (typically `44100 Hz`). Your recording must match this.

### Step 2 — Record your take aligned to the mix

1. In Audacity, with the reference track(s) open, add a new audio track (Tracks → Add New → Mono/Stereo Track).
2. Set Audacity to play the reference through your headphones (so you can hear what you're playing along to) while recording your own input.
3. Hit Record and play your rhythm part along with the reference from `t=0`. Critical: **start recording at the very beginning of the song.** If you punch in late, alignment will be off when you drop it in.
4. Stop when the song ends. Trim any silence/click at the very start of your recorded track so its first sample lines up with `t=0` of the reference (zoom in tight and check visually against the kick or first guitar hit).

### Step 3 — Export as OGG

1. **Solo** your recorded track (mute every reference track).
2. File → Export → Export as OGG Vorbis.
3. Quality slider: **5** (matches what the converter uses). Save as `rhythm_custom.ogg`.
4. Confirm in the export dialog that the sample rate is the same `44100 Hz` you noted in Step 1.

### Step 4 — Drop it in and update the manifest

1. Copy `rhythm_custom.ogg` into the sloppak's `stems/` folder.
2. Open `manifest.yaml` in any text editor (Notepad++, VS Code, BBEdit, gedit — all fine; just **don't use Word**).
3. Find the `stems:` block. Two things matter here:
   - **Order:** FeedBack's base `<audio>` element always plays the **first** stem listed in `stems[]`, regardless of `default:` flags. So if you want your custom stem to be what the player plays out-of-the-box (and what users without the Stems plugin will hear), put it **first**.
   - **`default:` flags:** consulted by the [Stems plugin](https://github.com/topkoa/slopsmith-plugin-stems) to decide which faders start un-muted. They do **not** affect what the base `<audio>` element plays — that's purely the first-stem rule above.

   Example for a Demucs-split sloppak where you re-recorded the rhythm guitar:

   ```yaml
   stems:
     - id: rhythm_custom         # listed first → base <audio> plays this
       file: stems/rhythm_custom.ogg
       default: true
     - id: guitar
       file: stems/guitar.ogg
       default: false            # Stems plugin starts this fader muted
     - id: bass
       file: stems/bass.ogg
       default: true
     - id: drums
       file: stems/drums.ogg
       default: true
     # … other stems unchanged …
   ```

   Example for a pre-split sloppak (only `full.ogg` exists):

   ```yaml
   stems:
     - id: rhythm_custom         # listed first → base <audio> plays this
       file: stems/rhythm_custom.ogg
       default: true
     - id: full
       file: stems/full.ogg
       default: false            # Stems plugin starts the full mix muted
   ```

4. Save the file. **Mind the indentation** — two spaces, no tabs. YAML is fussy about this.

### Step 5 — Reload and verify

Reload the song in FeedBack. The [Stems plugin](https://github.com/topkoa/slopsmith-plugin-stems) will show a fader for `rhythm_custom` next to the others. If you don't see it, check the cache notes in §1.

### Common gotchas

- **Sample-rate mismatch** → choppy/pitched-wrong playback. Re-export from Audacity at exactly the rate the other stems use.
- **Mono vs stereo mismatch** is fine for playback but levels can feel different — match what the other stems use if you want consistent behavior in the mixer.
- **Silence padding at the start** of your recording → your stem will play late. Trim it tight in Audacity before exporting.
- **Tabs in `manifest.yaml`** → FeedBack will refuse to load the song. Use two spaces.

---

## 3. Replace a bad Demucs stem

Demucs is good but not perfect. `htdemucs_6s` will occasionally bleed snare into `other.ogg` or leave drum overtones in the bass track. Fixing it works the same way as adding a custom stem — you're just overwriting an existing one.

### Option A: overwrite in place

1. Source or record a clean replacement and export it as OGG with the same sample rate.
2. Save it directly over the bad file (e.g. `stems/other.ogg`).
3. Reload — no manifest change needed.

### Option B: keep the original, add a replacement

Useful if you want to A/B them:

1. Save your new file as `stems/other_v2.ogg`.
2. In `manifest.yaml`, change the `file:` path on that stem's entry:

   ```yaml
   - id: other
     file: stems/other_v2.ogg     # was stems/other.ogg
     default: true
   ```

3. The old `other.ogg` stays in the folder but is no longer referenced. Delete it later if you want.

### Removing a stem entirely

If you want to drop a stem (e.g. `piano.ogg` is empty for this song):

1. Delete the file from `stems/`.
2. **Also remove** its entry from `manifest.yaml stems[]`. Leaving an orphan manifest entry pointing at a missing file produces a 404 in the player.

### A word on `full.ogg`

A converted sloppak starts with just `stems/full.ogg`. After Demucs splits it, the converter rewrites the manifest to list the per-instrument stems and removes `full.ogg`. If you're hand-editing and want to *keep* `full.ogg` as a fallback (mixed audio in case all the individual stems are muted), that's fine — leave the file in place and add a manifest entry with `default: false`. Don't delete `full.ogg` unless the per-instrument stems sum cleanly to a full mix.

---

## 4. Edit metadata, cover art, lyrics, tuning

All of these are tweaks to either `manifest.yaml` or files it points at. Open `manifest.yaml` in a text editor for the next three sections.

### Title, artist, album, year

Top-level keys in `manifest.yaml`. Just edit the strings:

```yaml
title: "Black Hole Sun"
artist: "Soundgarden"
album: "Superunknown"
year: 1994
duration: 320.5
```

Keep the quotes if the value already has them (especially when there's an apostrophe or colon). Reload the song — the library card updates next time the library refreshes.

### Cover art

Drop a square JPEG or PNG (500–1500 px on a side is the sweet spot) into the sloppak root and point the manifest at it:

```yaml
cover: cover.jpg
```

If the manifest doesn't have a `cover:` line, add one. The converter normally produces `cover.jpg` already; this is mostly relevant if you want to replace it with a better image.

### Lyrics

`lyrics.json` is a flat JSON list of syllable objects:

```json
[
  {"t": 12.34, "d": 0.18, "w": "Hel"},
  {"t": 12.52, "d": 0.22, "w": "lo-"},
  {"t": 13.10, "d": 0.30, "w": "world"}
]
```

| Field | Meaning |
|---|---|
| `t` | Time the syllable starts, in seconds (float) |
| `d` | Duration in seconds |
| `w` | The syllable text. A trailing `-` joins it to the next syllable as one word. A trailing `+` marks the last syllable of a line (the renderer wraps after it). Both are suffixes on a real syllable — not standalone entries |

Common hand-edits:
- **Karaoke timing is off** — bump `t` values up or down a few hundredths of a second.
- **Wrong word** — edit `w`.
- **Missing line break** — append `+` to the last syllable of the line that should end there (e.g. change `"w": "world"` to `"w": "world+"`). Don't insert a standalone `"+"` entry — that creates an empty syllable that still consumes word-spacing in the renderer.

It's plain JSON — edit in any text editor.

### Tuning

Per-arrangement, in `manifest.yaml`:

```yaml
arrangements:
  - id: lead
    name: Lead
    file: arrangements/lead.json
    tuning: [0, 0, 0, 0, 0, 0]    # E standard
    capo: 0
```

Each number is **semitones from E A D G B E**, lowest string first. Common tunings:

| Tuning | Offsets |
|---|---|
| E Standard | `[0, 0, 0, 0, 0, 0]` |
| Eb Standard | `[-1, -1, -1, -1, -1, -1]` |
| D Standard | `[-2, -2, -2, -2, -2, -2]` |
| Drop D | `[-2, 0, 0, 0, 0, 0]` |
| Drop C | `[-4, -2, -2, -2, -2, -2]` |
| DADGAD | `[-2, 0, 0, 0, -2, -2]` |

The manifest tuning overrides whatever's stored inside `arrangements/lead.json` — so fixing it here is enough; you don't need to touch the arrangement JSON.

For 4-string bass, only indices 0–3 are meaningful; leave 4 and 5 at `0`.

### What *not* to put in `manifest.yaml`

Don't add per-machine settings (audio device picks, MIDI port IDs), UI state, or your own play counts. The sloppak holds the song's authored data — anything that varies by user or machine lives in FeedBack's config dir or the metadata DB. See [feedpak spec §9.5](https://github.com/got-feedback/feedpak-spec/blob/main/spec/feedpak-v1.md#95-what-does-not-belong-in-a-feedpak) for the full list.

---

## 5. Re-zipping for distribution

If you want to share your modified sloppak with someone else, re-zip it:

1. Open the `mysong.sloppak/` directory.
2. Select **everything inside** — `manifest.yaml`, `arrangements/`, `stems/`, `lyrics.json`, `cover.jpg`.
3. Zip the **contents**, not the parent folder. (If you zip the folder, the zip will have a top-level `mysong.sloppak/` directory inside, which FeedBack won't parse — the manifest must be at the zip root.)
4. Rename `mysong.zip` → `mysong.sloppak`.

For your own use, you can skip this entirely — FeedBack reads the directory form straight from your DLC folder.

---

## Out of scope (for now)

- **Authoring a sloppak from scratch** (no Guitar Pro / MusicXML source file) — that's a developer task. Start at [feedpak spec §8 (Reading and writing)](https://github.com/got-feedback/feedpak-spec/blob/main/spec/feedpak-v1.md#8-reading-and-writing).
- **Editing notes / chords in `arrangements/*.json`** — technically possible but extremely tedious by hand: hundreds of objects with short field names per song. The fields are documented in [feedpak spec §6 (Arrangement JSON)](https://github.com/got-feedback/feedpak-spec/blob/main/spec/feedpak-v1.md#6-arrangement-json), but for any real chart edit you want the [Arrangement Editor plugin](https://github.com/got-feedback/feedBack-plugin-editor).
- **Loudness normalization / advanced stem processing** — out of scope here; standard Audacity or ffmpeg workflows apply to any OGG file before you drop it into `stems/`.
