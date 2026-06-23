# Spec 013 — `midi-control` Mappings Domain (the midi-input/midi-control split)

**Status:** documented future contract (RESERVED — not in the runtime graph) ·
**Issue:** #882 · **Depends on:** spec 012 (`midi-input`, delivered) · **Base:** `feedback/main`

## Summary

`midi-control` is the planned sibling of `midi-input`: it owns **MIDI control
mappings** — routing CC / pitchbend / note messages to *semantic actions* (drum
lane, transport command, effect parameter, etc.) — and **consumes `midi-input`**
for device access. It does **not** discover, select, or open devices; that is
`midi-input`'s job (spec 012, delivered).

This spec records the **split** so the boundary is unambiguous and the contract
is ready for whoever builds the runtime slice. Per project governance
(`docs/capability-safety-matrix.md`, `docs/capability-roadmap.md`), a future
domain stays **documentation-only until a PR ships its host workflow, a concrete
consumer, and tests** — so `midi-control` remains `RESERVED` in
`static/capabilities.js` `RESERVED_FUTURE_DOMAINS` until then. This spec does not
register a runtime domain.

## Why split it out

Before `midi-input` existed, "MIDI" meant two conflated concerns: getting bytes
from a device, and mapping those bytes to actions. The reserved `midi-control`
entry originally covered both. With `midi-input` delivered as the device control
plane, `midi-control` is narrowed to **mappings only** — mirroring how
`audio-input` (devices) is separate from `audio-effects`/`audio-mix` (what you do
with the signal). Keeping them separate prevents a future god-domain and lets the
device plane stabilize independently of mapping semantics.

## Boundary (normative)

- **`midi-input` owns:** device discovery (`discover`), source list, selection,
  open/close sessions, the Web-MIDI permission boundary, redacted device
  diagnostics. The raw MIDI message stream is delivered to in-page consumers via
  its session handle.
- **`midi-control` will own:** named mappings from MIDI events (note / CC /
  pitchbend, optionally channel-scoped) to semantic actions, mapping persistence,
  active-mapping selection, and "learn" capture. It **consumes** a `midi-input`
  session for the live stream; it never calls `requestMIDIAccess` or enumerates
  devices.

## Proposed contract (for the future implementation slice)

- **Owner:** `core.midi-control` (or a first-party MIDI-control plugin),
  `multi-provider`, safety `sensitive`.
- **Commands:** `list-mappings`, `get-mapping`, `set-mapping`, `delete-mapping`,
  `activate-mapping`, `inspect`.
- **Mapping shape (sketch):** `{ id, label, trigger: { type: 'note'|'cc'|'pitchbend',
  number?, channel? }, action: { domain?, command?|actionId, params? } }`.
- **Learn mode:** open a `midi-input` session, capture the next matching event,
  and bind it to the pending action (the per-plugin "learn" UIs in drums today
  are the reference behaviour to generalise).
- **Diagnostics:** `feedBack.midi_control.diagnostics.v1` — mapping summaries +
  bounded recent activations; **no raw MIDI streams, no device labels**.

## Intended consumers (promotion trigger)

The domain should be promoted out of RESERVED when a concrete consumer needs
shared mappings, e.g.:
- the generic **MIDI control plugin** (`feedback-plugin-midi`) — today an ad-hoc
  event→action mapper; the canonical first adopter.
- **drums** note→lane mapping + "learn mode" (`feedback-plugin-drums`,
  `feedback-plugin-drum-highway-3d`) — currently per-plugin; could adopt
  `midi-control` to share mapping logic once the contract is proven.

Until such a consumer-driven slice exists (with host workflow + tests), this
remains a documented contract only.

## Out of scope

- Any runtime registration / handlers (governance: no premature domain).
- Migrating the drums/keys per-plugin mapping now — deferred to the consumer slice.
- The device plane — owned by `midi-input` (spec 012, done).
