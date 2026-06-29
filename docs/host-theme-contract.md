# Host Theme Contract — design proposal

**Status:** proposal (charrette output, 2026-06-29) · **Owner area:** core v3 + plugin UI
**Trigger:** a plugin UI feature accidentally "carved itself into a single theme."

## 1. Problem

A results-card feature in the `note_detect` plugin (a glow-ring hero button + a
gradient-filled accuracy number) was built and visually verified against **only the
default skin** ("neon"). On the other skins it broke: on "esports" — a deliberately
glow-less, near-monochrome design language — the glow ring and the colour gradient
simply **vanished**. The colours adapted (everything used CSS custom-property tokens),
but the **visual devices themselves did not port**, because nothing in the system says
"this theme does / doesn't do glow rings."

### Root cause (three findings)

1. **Themes are design *languages*, not palettes.** neon = glow + animation + gradients;
   esports = no-glow, square, near-monochrome amber; metal = brushed steel + hard bevels +
   drop-shadows. Tokens made *colour* portable; they never made a *device* portable.
2. **Tokens are named by *device*, not *intent*.** e.g. `--nd-glow-*` holds a glow in neon
   but a **hard drop-shadow** in metal — the metal skin is already repurposing a
   device-named slot to express a different language. The cure is to finish that move:
   name slots by intent, with "off" (`none`) a legal value.
3. **No "text-legible-on-accent" role.** White-on-accent was hardcoded in several places;
   on esports' amber accent that's a contrast failure. And `--nd-accent2` was
   **double-booked** (gradient-end *and* S-grade colour), so the hero gradient resolved
   amber→near-white and washed out.

A process gap compounds it: **verification covered one skin**, so the regression was
invisible until a user switched themes. And this recurs ecosystem-wide — other plugins
ship their own independent skin systems too.

## 2. Current state (two disconnected systems)

| System | What it is | Limits |
| --- | --- | --- |
| **Host themes** (`static/v3/theme-core.js`, `html[data-fb-theme]`) | Cosmetic "shop" themes that recolour `fb-*` Tailwind tokens (surfaces/text/borders). | Apply-only & recolour-only. `--fbv-*` vars exist **only while a theme is equipped** (nothing to read in the default state). No read API, no capability signal, no normalized `theme:changed` event. Comment explicitly says it *leaves decorative accents (rings/shadows) at defaults* → **devices are an ownerless gap.** |
| **Plugin skins** (e.g. `note_detect` `data-nd-skin`) | Full per-plugin design languages (neon/esports/metal) as CSS-var blocks. | Each plugin reinvents the wheel; disconnected from host themes; a feature can't see both. |

## 3. Goals / non-goals

- **Goal:** a feature, authored once, renders correctly in **any** theme — including ones not
  yet invented — and degrades **intentionally** (neon ring → esports border), never accidentally.
- **Goal:** the host owns a canonical contract so plugins consume instead of reinventing.
- **Non-goal:** forcing every plugin skin to become a host theme. Skins stay plugin-local but
  **implement** the contract.
- **Non-goal:** backward-compat with pre-v3 hosts. Everything here is additive + feature-detected.

## 4. The contract — three layers

### Layer 1 — Semantic colour **roles** (always present)

The host writes default `--fb-*` role tokens on `:root` **unconditionally** (not only under
`[data-fb-theme]`), seeded from the canonical `fb` palette, so `var(--fb-accent, …)` always
resolves — themed or not. Roles:

**Namespace (normative).** The public contract lives under one prefix, **`--fb-*`**, written on
`:root` by a host-owned *contract stylesheet* (see §6 / §8) so it is present **themed or not**.
The existing `--fbv-*` vars stay **internal plumbing** — `theme-core.js` uses them only to
recolour the Tailwind `.bg-fb-*/.text-fb-*/.border-fb-*` utilities under `html[data-fb-theme]`;
they are **not** part of this contract and plugins must not read them. (Implementation may seed
`--fb-*` from the same source the `--fbv-*` overrides use, so an equipped theme moves both.)

**Value grammar (normative).** Colour roles are a **space-separated `r g b` triplet** (matching
today's `--fbv-*` and the Tailwind utilities), consumed as `rgb(var(--fb-accent))` with optional
alpha `rgb(var(--fb-accent) / .5)`. Recipe slots (Layer 2) hold **full CSS values** for their
device (a `box-shadow`, a `border` shorthand, a length, a paint), with `none` legal **except**
where noted.

**Normative role tokens** (all `--fb-*`, all always present):

| Role | Token | Notes |
| --- | --- | --- |
| surface / card / border | `--fb-surface` `--fb-card` `--fb-border` | structural |
| text / dim | `--fb-text` `--fb-text-dim` | |
| accent / second hue | `--fb-accent` `--fb-accent-2` | `accent-2` is **just a second hue** — never an assumed gradient end |
| status | `--fb-good` `--fb-warn` `--fb-bad` | maps onto today's palette `good / mid / low` (mid→warn, low→bad) — implementation aliases both |
| **on-fill (new)** | `--fb-on-accent` `--fb-on-good` `--fb-on-warn` `--fb-on-bad` | **Rule: every role used as a fill behind text gets a paired `--fb-on-*`** (fixes white-on-amber). Required + contrast-linted (§6). |
| **focus (new)** | `--fb-focus-ring` | focus indicator independent of `accent`, so focus stays visible when `accent ≈ surface` |

### Layer 2 — Capability **recipes** (intent-named slots; "off" is legal)

A theme declares its design *language* by filling intent-named slots (all `--fb-*`-prefixed,
same namespace as the roles). A feature applies the slot bundle **unconditionally**; it never
branches on "is this theme glowy?". Atomic slots (renames-by-intent of today's tokens):
`--fb-corner-radius`, `--fb-corner-clip`, `--fb-panel-shadow`, `--fb-text-emph-shadow`,
`--fb-panel-texture`, `--fb-motion-decorative` (reduced-motion-gated). For these, `none` is legal.

Two **composite recipes** carry the load:

- **EMPHASIS** — how this theme makes a primary action special:
  `--fb-emph-fill / --fb-emph-border / --fb-emph-halo / --fb-emph-on`.
  neon → halo (glow ring); esports → border (solid accent); metal → fill + drop-shadow.
  Any individual slot may be `none` — but a theme **must** emphasise *somehow* (at least one of
  fill/border/halo non-`none`), so a primary action is never visually flat.
- **ACCENT-TEXT** — how this theme fills a big accent number: `--fb-acc-text-fill`
  (decoupled from `accent-2`). neon/metal → a gradient; esports → a solid accent.
  **`--fb-acc-text-fill` is the one slot where `none` is illegal** — it is always a valid paint
  (solid colour or gradient), defaulting to `rgb(var(--fb-accent))`. Reason: the number is
  rendered with `background-clip: text` + transparent text-fill, so a `none` paint would make
  the digits **invisible** (transparent fill, nothing to clip) — which would violate the DoD
  "a device stays legible when its slot resolves to `none`". The feature also feature-detects
  `background-clip: text` and keeps a solid `color` base (see §5), so the digits are legible
  even where clip-text is unsupported.

> These generalize the interim per-skin tokens already shipped in `note_detect`
> (`--nd-hero-ring-idle/on`, `--nd-hero-border`, `--nd-acc-fill`).

### Layer 3 — JS read API + reconciliation

**The JS API is only for renderers that can't use CSS (canvas / WebGL), never for DOM/CSS
consumers** — those use the tokens and slots directly (§5). Critically, it exposes *resolved
token values*, **not** theme-style booleans: a `glow:false` flag can't tell a canvas whether to
draw a border, a bevel, a drop-shadow, or flat text, so there is **no** `capabilities()` of
booleans. On the existing `window.feedBack` bus:

- `feedBack.theme.get()` → `{ id, isThemed, tokens }` where `tokens` is the **resolved** map of
  every `--fb-*` role + recipe slot (the computed values, so a canvas reads the actual device,
  e.g. the gradient stops for `--fb-acc-text-fill`, not a boolean).
- `feedBack.theme.prefersReducedMotion()` → boolean (host wraps `matchMedia` once). **This is the
  single approved JS reduced-motion gate going forward** — existing direct `matchMedia` callers
  (`venue-mood-fx.js`, `pedal-cables.js`) migrate to it; `--fb-motion-decorative` covers the
  CSS-authored decorative motion.
- `theme:changed` event → `{ id, tokens }`.

**Lifecycle (normative).** `get()` always returns the **current effective theme synchronously**
and is valid at any time — before any theme is applied it returns the default/unthemed roles
(which always exist on `:root`). Theme application is async (it follows a `/api/profile` refresh);
`theme:changed` fires **only after** the DOM vars/classes are committed, and **once on initial
hydration** so a late-mounting plugin isn't stuck on stale state. **Plugin rule:** read `get()`
on mount, then subscribe to `theme:changed` — never assume an order between your mount and the
first theme apply.

**Reconciliation rule (ends the two-disconnected-systems problem):** a plugin skin
**derives surface/text/border from host tokens** (`--nd-bg: rgb(var(--fb-card))`, etc.) and
**owns only its accent + its devices**, selecting the device via the recipe. A host theme then
pulls plugin chrome along (one truth for surfaces), while the plugin layers identity on top and
never imposes a device the active theme neutralizes.

**Propagation scope (normative).** The contract is **same-document light-DOM**: `:root` `--fb-*`
inheritance and the central focus/motion rules (§6) reach any normal plugin screen. A plugin that
renders into a **shadow root or iframe** is responsible for bridging — copy the resolved
`get().tokens` into its sub-root and re-subscribe to `theme:changed` (host `:root` vars don't
cross those boundaries).

## 5. Consumption pattern (the rule for feature authors)

> **A feature may reference a colour *role* or a recipe *slot*. It may never write a raw
> device — no literal glow `box-shadow`, no literal `linear-gradient`, no hex.** Devices live
> in slots; the theme owns the slots.

```css
.hero-cta {
  background: var(--fb-emph-fill);
  border:     var(--fb-emph-border);
  box-shadow: var(--fb-emph-halo);   /* neon→ring · esports→none · metal→drop-shadow */
  color:      var(--fb-emph-on);     /* never hardcoded #fff again */
  border-radius: var(--fb-corner-radius);
}
.accuracy-number {
  /* Always-legible solid base; survives no-clip-text support too. */
  color: rgb(var(--fb-accent));
}
/* Apply the clipped paint ONLY where supported — and --fb-acc-text-fill is
   guaranteed a real paint (never `none`, per Layer 2), so the digits can't go
   invisible. */
@supports ((background-clip: text) or (-webkit-background-clip: text)) {
  .accuracy-number {
    background: var(--fb-acc-text-fill);
    -webkit-background-clip: text; background-clip: text;
    -webkit-text-fill-color: transparent;
  }
}
```

**Where the contract physically lives.** A **host-owned static contract stylesheet** (e.g.
`static/v3/theme-contract.css`, hand-authored, linked from `static/v3/index.html`) holds the
always-present `:root --fb-*` defaults **plus** the two central a11y rules below. It is **not** a
Tailwind file, so it never touches the prebuilt `static/tailwind.min.css` artifact the
`tailwind-fresh` CI check diffs (and it's independent of `theme-core.js`, which keeps
runtime-injecting only the `--fbv-*` utility overrides under `[data-fb-theme]`).

- **Reduced motion:** `--fb-motion-decorative` is the *only* place CSS decorative animation is
  named; one central rule in the contract sheet sets it to `none` under
  `@media (prefers-reduced-motion: reduce)`, so no theme can forget the gate. (JS-driven motion
  uses `feedBack.theme.prefersReducedMotion()` — §4.3.)
- **Focus parity:** one contract-level `:focus-visible { outline: 2px solid rgb(var(--fb-focus-ring)) }`
  for contract consumers; themes recolour `--fb-focus-ring` but may not author their own focus
  styling. *Migration:* v3 already ships component-specific focus + reduced-motion rules in
  `v3.css`; those are reconciled onto the contract token (not magically replaced) as a tracked
  cleanup — "one rule" describes the end state, not day one.
- **On-fill contrast:** every `--fb-on-*` is required and **lintable**
  (`contrast(on-X, X) ≥ 4.5:1`, 3:1 large) for each fill role (`accent / good / warn / bad`).
  Contrast is the theme's job, computed once — not re-judged per feature.

## 7. Verification gate (prevent recurrence)

- A committed **render-matrix** tool, driven off the runtime skin list, that renders the key
  surfaces (hero CTA, accent number, **and the canvas share-image card**) across **every skin ×
  key states** (rest / hover / focus / reduced-motion).
- The gate is **computed-style invariant assertions** (deterministic, CI-safe) — e.g. "emphasis
  present and text legible in each theme" — **not** pixel-snapshot diffing (the animated ring +
  fonts + AA make snapshots flaky); a contact-sheet montage is the human backstop.
- Triggered on the version bump that CSS changes already require; skins enumerated at runtime +
  a guard test so the matrix can't silently go stale.

**Definition-of-done for any theme-touching UI change** (the few items that would have caught this):
expressed via tokens not hardcoded values · rendered across all skins · **a new visual *device*
stays legible when its slot resolves to `none`** · reduced-motion + focus parity · on-accent contrast.

## 8. Back-compat & rollout

All additive: the new always-present `--fb-*` tokens (in the contract sheet, §6) + a new
`feedBack.theme` namespace + a new event with no current listeners. Existing plugins (those
reading `fb-*` Tailwind utility classes, or shipping their own skins) are untouched unless they
opt in. On a host too old to ship the contract sheet, a consumer still degrades cleanly: the
two-arg fallback `rgb(var(--fb-accent, 224 128 32))` resolves to the literal, and
`window.feedBack?.theme?.get?.()` is feature-detected — so older hosts behave exactly as today.

**Workstream (sub-tasks):**
1. **Host minimal surface** — the contract stylesheet's always-present default `--fb-*` tokens + `feedBack.theme.{get, prefersReducedMotion}` (`get().tokens` = resolved values; no boolean `capabilities()`) + `theme:changed`. *(the smallest thing that would have prevented the incident)*
2. **note_detect refactor** — rename device tokens by intent (EMPHASIS + ACCENT-TEXT recipes), add `on-accent` + `focus-ring`, derive surfaces from host tokens.
3. **Verification gate** — commit the render-matrix + DoD checklist; add the canvas share-card surface.
4. **Ecosystem migration guide** — document the contract + the consumption rule for community plugin authors.

## 9. Cross-apply status (already done)

- `note_detect` results-card hero + accuracy number — fixed via per-skin device tokens
  (the Layer-2 prototype) and verified across neon/esports/metal.
- The **canvas share-image card** — re-checked across all three skins: **theme-robust**
  (reads per-skin colour tokens via computed style, draws skin-neutral solid devices). Minor
  fidelity gap only: it uses flat `--nd-bg` and skips metal's brushed-steel *texture*.

## 10. Open questions

- Should plugin skins eventually become *selectable host themes* (one picker), or stay
  plugin-local forever? (This proposal assumes plugin-local + contract-implementing.)
- Component-recipe **bundles** (per named component) are the richer end-state; intent-named
  slots are the right seed. When/whether to graduate.

*(Resolved during review and folded into the sections above: the token namespace + value grammar
and normative role table (§4.1); the `none`-is-illegal carve-out for `--fb-acc-text-fill` (§4.2);
JS exposes resolved tokens, not booleans (§4.3); `theme:changed` lifecycle + shadow/iframe
propagation (§4.3); the physical home of the role tokens + central focus/motion rules — a
host-owned contract stylesheet outside Tailwind (§6).)*
