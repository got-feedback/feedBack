# Instrument Plugins

Instruments in fee[dB]ack are defined by bundled **instrument plugins** — each is a
small `plugins/instrument_<name>/` directory with a `plugin.json` manifest and an
SVG icon. They declare the instrument's tuning presets, string/key counts,
arrangement role mappings, and detection strategy, replacing hardcoded checks
across the codebase.

## Interface

Each instrument plugin sets `"type": "instrument"` in its manifest and carries an
`"instrument"` block with the following schema:

```jsonc
{
  "id": "instrument_guitar",        // unique plugin id (snake_case, prefixed "instrument_")
  "name": "Guitar",                 // human-readable name
  "version": "1.0.0",
  "type": "instrument",             // ⬅ required
  "bundled": true,                  // a bundled plugin (not user-installed)
  "icon": "assets/icon.svg",        // path relative to the plugin directory
  "instrument": {
    "id": "guitar",                 // instrument id (snake_case, used in settings & profiles)
    "label": "Guitar",              // display label for the instrument selector
    "kind": "stringed",             // "stringed" | "keyboard" | "percussion" | "vocal" | "custom"

    // ── Stringed instruments ──────────────────────────────────────────────
    "string_counts": [6, 7, 8],     // (required for stringed) array of ints
    "default_string_count": 6,      // (required for stringed) must be in string_counts
    "fret_counts": [21, 22, 24],    // (required for stringed) array of ints
    "default_fret_count": 22,       // (required for stringed) must be in fret_counts
    "reference_pitch": 440.0,       // A4 reference (default 440)
    "standard_tunings": {           // (required for stringed) open MIDI pitches per string count
      "6": [40, 45, 50, 55, 59, 64],
      "7": [35, 40, 45, 50, 55, 59, 64],
      "8": [30, 35, 40, 45, 50, 55, 59, 64]
    },
    "tunings": {                    // (required for stringed) named tuning presets per string count
      "6": {
        "E Standard":  [ 0,  0,  0,  0,  0,  0],
        "Drop D":      [-2,  0,  0,  0,  0,  0],
        "Eb Standard": [-1, -1, -1, -1, -1, -1]
      }
    },

    // ── Keyboard instruments ───────────────────────────────────────────────
    "key_counts": [25, 49, 61, 88], // (required for keyboard) array of ints
    "default_key_count": 88,        // (required for keyboard) must be in key_counts

    // ── All instruments ────────────────────────────────────────────────────
    "detect_strategy": "pitch",     // "pitch" (uses tuner) | "onset" (drums) | null
    "roles": [                      // one or more arrangement roles
      {
        "id": "lead",               // role id (snake_case), used in profile ids
        "label": "Lead",            // display label for the role selector
        "arrangement_flags": ["path_lead"],  // XML flags that identify this role
        "arrangement_names": ["Lead", "Lead Guitar"],  // names that identify this role
        "default": true             // the default role for this instrument
      }
    ]
  }
}
```

### `kind` values

| Kind | Example | Has tunings? | Has string counts? | Notes |
|------|---------|:---:|:---:|-------|
| `"stringed"` | guitar, bass | Yes | Yes | Shows tunings, frets, handedness in the selector |
| `"keyboard"` | piano, keys | Yes | No (key counts instead) | Shows key count selector |
| `"percussion"` | drums | No | No | No tuner, hit detection |
| `"vocal"` | vocals | No | No | Pitched, uses tuner, no instrument-specific controls |
| `"custom"` | any future type | Depends | Depends | Free-form |

### Role mapping

When a player selects a role (e.g. Guitar → Rhythm), the highway opens the
arrangement matching that role. Roles match against:

1. **Arrangement flags** — XML `<arrangementProperties>` attributes (e.g. `path_bass`, `path_lead`).
   Flagged arrangements match immediately, regardless of name.
2. **Arrangement names** — matched case-insensitively against the arrangement's
   smart name (from XML parsing) and raw name. List common GP/RS2014 naming
   variants for each role to maximise coverage (e.g. `["Bass", "Pick Bass", "Fingered Bass"]`).

The library auto-filters to arrangements matching the current instrument's roles.

## Creating a new instrument plugin

1. Create `plugins/instrument_<id>/plugin.json` (copy the skeleton below).
2. Create `plugins/instrument_<id>/assets/icon.svg` — use a
   **[CC0-licensed SVG from SVGrepo's music instrument collection](https://www.svgrepo.com/collection/music-instrument)** (all free for any use, no attribution required).
3. Fill in the `instrument` block with tunings, string/fret/key counts, and role
   mappings for your instrument.
4. Restart fee[dB]ack — the loader discovers the plugin automatically.

### Minimal skeleton

```jsonc
{
  "id": "instrument_<id>",
  "name": "<Display Name>",
  "version": "1.0.0",
  "type": "instrument",
  "bundled": true,
  "icon": "assets/icon.svg",
  "instrument": {
    "id": "<id>",
    "label": "<Display Name>",
    "kind": "stringed",
    "string_counts": [6],
    "default_string_count": 6,
    "fret_counts": [22, 24],
    "default_fret_count": 22,
    "reference_pitch": 440.0,
    "standard_tunings": {
      "6": [40, 45, 50, 55, 59, 64]
    },
    "tunings": {
      "6": { "E Standard": [0, 0, 0, 0, 0, 0] }
    },
    "detect_strategy": "pitch",
    "roles": [
      {
        "id": "<role>",
        "label": "<Role Label>",
        "arrangement_names": ["<Arr Name>"],
        "default": true
      }
    ]
  }
}
```

### Non-stringed skeleton

```jsonc
{
  "id": "instrument_<id>",
  "name": "<Display Name>",
  "version": "1.0.0",
  "type": "instrument",
  "bundled": true,
  "icon": "assets/icon.svg",
  "instrument": {
    "id": "<id>",
    "label": "<Display Name>",
    "kind": "vocal",
    "string_counts": [],
    "default_string_count": 0,
    "key_counts": [],
    "default_key_count": 0,
    "reference_pitch": 440.0,
    "detect_strategy": "pitch",
    "roles": [
      {
        "id": "<role>",
        "label": "<Role Label>",
        "arrangement_names": ["<Arr Name>"],
        "default": true
      }
    ]
  }
}
```

## Bundled instruments

These ship with fee[dB]ack and are in the `plugins/` directory tree by default:

| Plugin directory | Instrument id | Kind |
|------------------|:---:|---|
| `instrument_guitar` | `guitar` | stringed |
| `instrument_bass` | `bass` | stringed |
| `instrument_drums` | `drums` | percussion |
| `instrument_piano` | `keys` | keyboard |
| `instrument_vocals` | `vocals` | vocal |
