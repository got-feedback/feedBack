# The feedpak spec-conformance gate

`tools/check_spec_conformance.py`, run in CI as the `feedpak-spec` job.

## Why

feedpak is published as an **open format**: its own repo
([got-feedback/feedpak-spec](https://github.com/got-feedback/feedpak-spec)), a normative spec, JSON
Schemas, and a reference validator. That is a promise to everyone outside this codebase — third-party
packers, converters, and players build against the spec, and the spec is meant to be the complete and
authoritative description of a pack.

The moment core reads a manifest key the spec doesn't define, that promise breaks silently:

- A spec-compliant pack is no longer guaranteed to be a fully-working pack.
- The reference validator can't warn authors about a key it has never heard of — it will happily green-light
  the key, and every misspelling of it.
- The format's real definition drifts into our source tree. In the case that motivated this gate
  ([#933](https://github.com/got-feedback/feedback/issues/933)), third-party tooling started emitting an
  `original/` directory that no code anywhere requires — the convention was reverse-engineered from an
  example in a *code comment*.

The rule this gate enforces: **any manifest key core reads _or writes_ must be in the spec before core
ships code that depends on it.** Spec first, implementation second. Writes are not exempt — a key core
writes lands in every pack we emit, so an undeclared one seeds the ecosystem with non-spec data.

Note that "get it into the spec" is not automatically the right fix for an existing violation — for
`original_audio` it isn't. The spec already carries the pre-separation mixdown as a stem
(`{id: full, file: stems/full.ogg}`), so that key added a *second, redundant* location for audio to a format
that already had one, and the resolution is to remove it rather than bless it. The gate takes no position on
which way a violation resolves; it only insists that one of the two happens deliberately, in the open,
before the code merges.

## What it checks

We can't mechanically prove core *interprets* a key the way the spec means. We can prove four surface
properties, and they cover the drift that actually occurs.

| Layer | Check | Catches |
|---|---|---|
| 1. key-coverage | Every manifest key core reads **or writes** is declared in the spec's `manifest.schema.json`. | Core growing a key the spec never defined — the #933 class. |
| 2. allowlist-closed | `feedpak-spec-exceptions.yml` has not **grown** relative to the base branch. | Someone routing around the FEP process by allowlisting their own new key. |
| 3. forward | Core's `load_song()` ingests every example pack the spec ships. | The spec adding or tightening something core ignores or breaks on. |
| 4. reverse | Every pack committed to this repo passes the spec's `tools/validate.py`. | Core (or a contributor) committing a pack the spec would reject. |

Layer 1 works by walking the AST of the modules listed in `READERS` and collecting every literal key touched
on a manifest dict (`manifest.get("x")`, `manifest["x"]`, and the wrapped
`(load_manifest(p) or {}).get("x")` form used in `lib/enrichment.py`).

**Reads and writes are both checked, and reported differently.** A key core *writes*
(`manifest["x"] = v`, as `lib/songmeta.py` does) is spec surface pointed outward: it puts a key into every
pack we emit, so an undeclared one seeds the ecosystem with non-spec data. Subscripts are classified by AST
context — `Store` is a write, `Load` is a read — so `manifest["year"] = ...` is not miscounted as a read.

## When it fails

You added a manifest key the spec doesn't define. **There is exactly one way forward, and it is not in this
repo.**

Land the key in the spec through the **feedpak Enhancement Proposal (FEP)** process
([feedpak-spec/CONTRIBUTING.md](https://github.com/got-feedback/feedpak-spec/blob/main/CONTRIBUTING.md)):

1. **Open a FEP issue** on `got-feedback/feedpak-spec` — the problem, the proposed on-disk shape (manifest
   key and/or side-file), backward compatibility, and the version bump it implies.
2. **Discuss**, until it has a clear shape and rough consensus.
3. **Land one PR there** that updates the normative spec (`spec/feedpak-v1.md`), the relevant JSON
   Schema(s), an example in `examples/` that exercises it, and the changelog — *together*. A PR touching
   only one of those is incomplete.
4. **Back here**, just re-run your PR's checks. The gate verifies against the spec's HEAD, so the moment
   your key is genuinely part of the format, your PR goes green — nothing to bump, nothing to maintain.

That's deliberately the only route — no experimental prefix, no self-serve allowlist — and it's usually a
quick one for additive keys. The reason it's worth the round-trip: the gate checks the whole repo against
the living spec, so if non-conformance ever lands, it shows up as red CI on *every* teammate's open PR, and
only the person who introduced it can clear it. Going through the FEP keeps your change clean and keeps
everyone else unblocked.

The spec's own governance says the same thing:

> This repository defines the format only. Applications that read or write feedpak ... track this spec as a
> dependency; they do not drive it. **A change is not part of the format until it lands here.**
> — [feedpak-spec/GOVERNANCE.md](https://github.com/got-feedback/feedpak-spec/blob/main/GOVERNANCE.md)

### `feedpak-spec-exceptions.yml` is a closed grandfather list, not a hatch

It exists solely because `original_audio` predates the gate. **CI fails any PR that adds an entry** (layer 2
diffs it against the base branch), so the list can only ever shrink. Entries are debt, each carries a
tracking issue, and each disappears when the underlying key is removed from core. The gate also fails on a
*stale* entry — the spec caught up, or core stopped touching the key — so the file cannot quietly become
somewhere drift accumulates.

Deleting an entry does not, by itself, get you past the gate: layer 1 still fails while core reads the key.
The entry goes when the **code** goes.

## Tracking the spec's HEAD

The gate checks out `feedpak-spec` at **HEAD**, on purpose: the app must conform to the *living* spec, and
nobody should have to maintain a pin. The dev flow is fully self-serve — gated PR → FEP → spec merge →
re-run checks → green.

Two properties to know about:

- **The normal FEP is additive** (a new optional key), which only ever makes the gate *looser* — it cannot
  redden anyone's PR. Only a **breaking** spec change (removing/renaming a key the app uses, tightening the
  validator against committed packs) turns PRs red repo-wide — and per the spec's compatibility policy that
  is a rare, deliberate MAJOR event, exactly when an org-wide "the app is out of conformance" signal is the
  right outcome. The CI job logs the exact spec SHA each run verified against, so a red run is reproducible.
- **CI results can change over time on the same commit** — that is inherent to tracking a living contract,
  and it is the point: green means "conformant *now*", not "conformant when written".

## Limitations

Known, and worth fixing in follow-ups rather than blocking on:

- **Layer 1's receiver detection is heuristic.** Locals *assigned from* `load_manifest(...)` are discovered
  flow-aware whatever they're called (chart.py's `m` taught us that), and the inline
  `(load_manifest(p) or {}).get(...)` form is recognised — but a manifest that arrives as a **function
  parameter** is only recognised by name (`MANIFEST_VARS`: `manifest`, `mf`). A parameter called something
  else would slip. The hardening step is to route all manifest access through a single declared
  `KNOWN_MANIFEST_KEYS` registry in `lib/sloppak.py`; the gate then compares registry against schema exactly
  instead of inferring.
- **Layer 1 covers top-level keys only.** Nested structure (`arrangements[].file`, `.id`, `.notation`) isn't
  checked. Extending to it means walking the schema's `$ref` subschemas.
- **Layer 1 recognises `get`, `setdefault`, subscripts, and the known gap-fill helper** as key access.
  `update()` and `pop()` aren't used against a feedpak manifest anywhere in the tree, so they're deliberately
  not special-cased rather than speculatively handled. `readers-complete` reuses the same scanner
  (`keys_touched()`), so this blind spot is shared, not doubled: a module using only unrecognised access forms
  would evade both.
- **Layer 4 can't catch unknown keys**, because `manifest.schema.json` sets `additionalProperties: true` and
  the reference validator deliberately "treats unknown keys/files as forward-compatible". Fixing this
  properly belongs in the spec (tighten the schema, or give the validator a `--strict` mode). Until then,
  layer 1 is the only thing standing between us and the next `original_audio`.
