# Size-exemption register

The working norm (constitution Principle II; enforced by the `max-lines` lint
gate) is **no source file over 1,500 lines**. A few files are allowed to exceed
it because splitting them would do more harm than good — hot per-frame
renderers, C++, offline generators, cohesive registries. This register is the
list of those exceptions: each row is a **deliberate, signed** decision with a
ceiling, a rationale, and a review trigger. Without it, "no file over 1,500
without a *signed* exemption" is unenforceable.

**Rules**
- One row per file: a ceiling, a rationale, a signer, a review trigger.
- The `max-lines` per-file ceilings in `eslint.config.js` mirror this table —
  keep them in sync (this register is canonical).
- Files with a scheduled split **plan** are *not* exempt — they live in
  "Planned, not exempt" at the bottom so nothing falls between the two states.
- **Signers** (decided 2026-07-08): **Byron** signs core + bundled rows;
  **Christian** signs the authored-plugin row (virtuoso, its own repo/track).

## Permanent exemptions (structural rationale)

| Repo / file | Lines (7-07) | Ceiling | Rationale | Signer | Review |
|---|---|---|---|---|---|
| core `static/highway.js` → residual `renderer-2d.js` (post-split) | ~2,400–2,900 est. | **3,000** | 60 fps hot path; no module boundary inside the per-frame loop | Byron | after the highway.js split |
| core `plugins/highway_3d/` → residual renderer | sized at split; likely **>3,000** | set at split, flagged now | same hot-path rule; the draw core can't be cut without behavior risk | Byron | after the highway_3d split |
| core `static/capabilities.js` | 1,538 | 1,600 | cohesive registry + `window.feedBack` bus, 38 lines over; a split spends credibility for nothing | Byron | R4 |
| tutorials `builtin/reading-the-highway/generate.py` | 1,818 | 2,000 | offline content generator, never imported at runtime, deps not in runtime requirements | Byron | if a 3rd builtin pack appears |
| desktop `src/audio/NodeAddon.cpp` | 3,542 | as-is | C++, outside the ESM/routes playbooks; under active use-after-free crash work — do not churn | Byron | after crash-class work settles |
| desktop `src/audio/AudioEngine.cpp` | 2,977 | as-is | same | Byron | same |
| desktop `src/vst-host/main.cpp` | 1,928 | as-is | same | Byron | same |
| virtuoso `screen.js` (authored, own track) | 25,741 | as-is until its own split | authored plugin on a separate roadmap; migrates on its own schedule | Christian | virtuoso split kickoff |

## Split-when-touched (no scheduled train; row retires when split)

| Repo / file | Lines | Ceiling | Rationale | Signer | Review |
|---|---|---|---|---|---|
| core `lib/gp2rs_gpx.py` | 2,540 | as-is | import converter, off the serve-path hot loop | Byron | when next touched |
| core `lib/gp2rs.py` | 2,055 | as-is | same | Byron | when next touched |
| core `lib/song.py` | 1,689 | as-is | data models + wire format; cohesive | Byron | when next touched |
| core `lib/gp_autosync.py` | 1,572 | as-is | under active dev (#787/#791) — don't collide | Byron | after in-flight work lands |
| core `plugins/capability_inspector/screen.js` | 1,752 | as-is | bundled diagnostics plugin, low churn | Byron | when next touched |
| core `plugins/folder_library/screen.js` | 1,672 | as-is | bundled plugin, low churn | Byron | when next touched |

## Temporary rows (cleared by a scheduled PR)

| Repo / file | Lines | Cleared by |
|---|---|---|
| core `plugins/__init__.py` | ~2,470 (grew under R0) | the `plugins/_routes.py` + `plugins/_registry.py` split (rides the server.py router work) |

## Watch list (under the norm — no row needed, re-census each phase)

`musicxml-import/mxml2notation.py` (1,456) · core `static/capabilities/audio-effects.js`
(1,436) · `studio routes.py` (1,399) · `update-manager screen.js` (1,492 — zero headroom).

## Planned, NOT exempt (owned by split plans — listed so nothing falls between states)

core `static/app.js` (11,852) · `static/highway.js` (4,168, whole file) · `server.py`
(5,540 — was 14,037; ratcheted by the R3 `MetadataDB` + `AudioEffectsMappingDB`
extractions and sixteen `routers/` modules (the album-art routes are now `lib/routers/art.py`); the ~930-line metadata-enrichment subsystem — MB/CAA/AcoustID transport, matcher, background worker — now lives in `lib/enrichment.py`) ·
`lib/metadata_db.py` (4,373 — new in R3; the `MetadataDB` class alone is 4,018 lines
and is a monolith in its own right, to be split per-table once the router train
lands) · `static/v3/songs.js` (4,134) · `static/capabilities/audio-session.js`
(2,974) · `plugins/highway_3d/screen.js` (15,656) · `plugins/keys_highway_3d/screen.js`
(3,780) · `plugins/drum_highway_3d/screen.js` (3,597) — and every monolith with a PR
train in the refactor plan. Test files (e.g. `tests/test_plugins.py`) are out of scope
by policy — the norm governs source files.
