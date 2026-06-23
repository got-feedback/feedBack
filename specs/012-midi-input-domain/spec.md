# Spec 012 — MIDI-Input Control-Plane Capability Domain

**Status:** active (control-plane slice) · **Issues:** #873 (impl), #880 (this spec) · **Base:** `release/v0.3.0`

## Summary

`midi-input` is a **core-owned provider-coordinator** capability domain for MIDI
device discovery, selection, and open/close session lifecycle — the MIDI analog
of `audio-input` (spec 006). It gives every MIDI consumer in FeedBack (the
`input_setup` onboarding wizard, the `piano`/keys and `drums` plugins, and — as
a follow-up — note-detection's Web-MIDI provider) **one device-access boundary**:
one permission prompt, one source list, one redaction boundary.

## Motivation

Today each MIDI consumer calls `navigator.requestMIDIAccess()` privately
(piano, drums, plugin-midi, note-detection's `midi` provider kind), so there is
no shared source list, no single permission prompt, and no common redaction of
device labels. The onboarding input-setup step (#874/#876/#877) needs a single
governed surface to pick and verify a MIDI device per instrument.

## Why not reuse `audio-input`

`audio-input`'s source/`source.open` contract is audio-frame-centric:
`channelSummary`/`channelCount`/`channelShape`, `requiredChannelShape`, and
redaction keyed to audio handles/buffers/samples. MIDI carries discrete messages
and has no channel shape. Folding MIDI in would overload the audio contract and
its redaction boundary. A sibling domain keeps both contracts clean and lets
each evolve independently — the same reasoning that made `audio-input` and
`audio-monitoring` siblings rather than one domain.

## Why core-owned (not plugin-owned)

An input control plane outlives any one feature; `audio-input` is
`core.audio.session`-owned, not owned by a feature plugin. If `input_setup`
owned `midi-input`, the domain's lifetime would be coupled to the wizard, and
migrating ownership later (every consumer, persistence key, diagnostics schema
references the owner) is costly. The domain is `core.midi-input`.

## Contract

- **Owner:** `core.midi-input`, kind `provider-coordinator`, safety `sensitive`.
- **Public commands:** `inspect`, `list-sources`, `discover`, `select-source`,
  `open-source`, `close-source`.
- **Provider operations:** `source.enumerate`, `source.describe`, `source.open`,
  `source.close`.
- **Events:** `provider-registered`, `provider-unregistered`,
  `availability-changed`, `sources-changed`, `source-selected`, `source-opened`,
  `source-closed`.

### Sources & identity

Providers register source summaries with `providerId`, a stable `sourceId`, a
derived **redaction-safe** `logicalSourceKey` (`providerId::sourceId`),
`kind: "midi"`, a label, and `availability`. Persistence and diagnostics use the
`logicalSourceKey`, never the human device label.

### Permission model (Web-MIDI nuance)

`requestMIDIAccess()` gates the **whole input list**, so **`discover` is the
permission boundary** (not `open-source`, as it is for audio). `inspect` /
`list-sources` / `select-source` are **prompt-free** and never request access.
`discover` records `denied` / `unavailable` outcomes; `open-source` attaches a
shared listener session to an already-discovered source and never re-prompts.

### Sessions

One shared open session per source across requesters (refcounted); the provider
receives `source.close` only after the last requester releases. Live MIDI
message delivery (for the "play a note / hit a pad" calibration check) is exposed
to in-page consumers via the public `window.feedBack.midiInput` session handle
**only** — never as raw capability events or in diagnostics.

### Persistence & redaction

Selected source persists under `feedBack.midiInput.selectedLogicalSourceKey`.
Diagnostics (`feedBack.midi_input.diagnostics.v1`) carry provider ids, source
ids/keys/kinds/availability, the selected key, and open-session keys; device
**labels are redacted** and **no raw MIDI messages** are ever included.

## Split from `midi-control`

The reserved `midi-control` domain is narrowed to **control mappings only**
(CC/pitchbend/note → action routing) and will consume `midi-input` for device
access. This spec carves out the device control plane so `midi-control` can stay
mappings-only (#882).

## Consumers (separate issues)

- `input_setup` onboarding wizard — keys/drums device pick + verify (#876/#877).
- `piano` / `drums` plugins — consume `midi-input` instead of private
  `requestMIDIAccess()` (via the sub-flow issues; legacy retired through bridges).
- note-detection's Web-MIDI provider migrates onto `midi-input` (#881).

## Acceptance

- Owner registers; appears in the Capability Inspector with the commands above.
- `discover` is the only command that triggers `requestMIDIAccess()`;
  `inspect`/`list-sources`/`select-source` never prompt.
- Selection persists across reload by `logicalSourceKey`.
- Diagnostics contain no device labels or raw MIDI messages.
- A consumer can `discover` → `select-source` → `open-source` → receive live
  note-on for the calibration check → `close-source` (session refcount releases).

## Out of scope (follow-ups)

- `midi-control` mapping/routing domain (#882).
- note-detection provider migration onto `midi-input` (#881).
- Retiring per-plugin `requestMIDIAccess()` in piano/drums via compatibility
  bridges (tracked with the sub-flow issues).
