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

`surface · card · border · text · text-dim · accent · accent-2 · good · warn · bad`
plus two **new keystones**:

- **`on-accent`** — foreground legible *on* an accent fill. (Rule: any role used as a fill
  behind text gets a paired `on-*`.) Fixes white-on-amber.
- **`focus-ring`** — focus indicator independent of accent, so focus stays visible when
  `accent ≈ surface`.

`accent-2` is demoted to "just a second hue" — **never** an assumed gradient end.

### Layer 2 — Capability **recipes** (intent-named slots; "off" is legal)

A theme declares its design *language* by filling intent-named slots. A feature applies the
slot bundle **unconditionally**; it never branches on "is this theme glowy?". Atomic slots
(renames-by-intent of today's tokens): `corner-radius`, `corner-clip`, `panel-shadow`,
`text-emph-shadow`, `panel-texture`, `motion-decorative` (reduced-motion-gated).

Two **composite recipes** carry the load:

- **EMPHASIS** — how this theme makes a primary action special:
  `--emph-fill / --emph-border / --emph-halo / --emph-on`.
  neon → halo (glow ring); esports → border (solid accent); metal → fill + drop-shadow.
  None empty — each emphasises in its own language.
- **ACCENT-TEXT** — how this theme fills a big accent number: `--acc-text-fill`
  (decoupled from `accent-2`). neon/metal → a gradient; esports → a solid accent.

> These generalize the interim per-skin tokens already shipped in `note_detect`
> (`--nd-hero-ring-idle/on`, `--nd-hero-border`, `--nd-acc-fill`).

### Layer 3 — JS read API + reconciliation

On the existing `window.feedBack` bus:

- `feedBack.theme.get()` → `{ id, tokens, isThemed }`
- `feedBack.theme.capabilities()` → `{ glow, gradients, motion }` (the device-affordance signal)
- `feedBack.theme.prefersReducedMotion()` → boolean (host wraps `matchMedia` once)
- `theme:changed` event → `{ id, tokens, capabilities }` (emitted at theme-core's existing
  apply chokepoint; analogous to `note_detect`'s `notedetect:skin`)

**Reconciliation rule (ends the two-disconnected-systems problem) — depends on whether the
plugin has its own identity:**

- **A plugin *without* its own skin** should **derive surface/text/border from host tokens**
  (`background: var(--fbv-card)`, etc.) and **own only its accent + its devices**, selecting the
  device via the recipe. A host theme then pulls its chrome along — one truth for surfaces — and
  it never imposes a device the active theme neutralizes. This is the common case.
- **A plugin *with* deliberate skins** (e.g. `note_detect`'s neon / esports / metal, which are
  full design languages) **owns its surfaces** — deriving them from the host theme would *erase*
  the skin's identity (metal's brushed steel becomes a flat host colour). Such a plugin adopts the
  **role + recipe *pattern*** (per-skin device tokens, `on-accent`, `focus-ring`, "off" is legal)
  and verifies across **its own** skin matrix, but does not blindly inherit host surfaces.
  *(Decided 2026-06-29: keep note_detect's skins self-owned + their current button text — so the
  fix is the per-skin device pattern + the verification gate, not surface-derivation.)*

## 5. Consumption pattern (the rule for feature authors)

> **A feature may reference a colour *role* or a recipe *slot*. It may never write a raw
> device — no literal glow `box-shadow`, no literal `linear-gradient`, no hex.** Devices live
> in slots; the theme owns the slots.

```css
.hero-cta {
  background: var(--emph-fill);
  border:     var(--emph-border);
  box-shadow: var(--emph-halo);   /* neon→ring · esports→none · metal→drop-shadow */
  color:      var(--emph-on);     /* never hardcoded #fff again */
  border-radius: var(--corner-radius);
}
.accuracy-number {
  color: var(--accent);           /* legible solid fallback FIRST */
  background: var(--acc-text-fill);
  background-clip: text; -webkit-background-clip: text; -webkit-text-fill-color: transparent;
}
```

## 6. Accessibility (baked into the contract, not per-feature)

- **Reduced motion:** `motion-decorative` is the *only* place decorative animation is named;
  one central rule sets it to `none` under `@media (prefers-reduced-motion: reduce)`, so no
  theme can forget the gate.
- **Focus parity:** exactly one contract-level `:focus-visible { outline: 2px solid var(--focus-ring) }`;
  themes recolour `focus-ring` but may not author their own focus styling.
- **On-accent contrast:** `on-accent` is required and **lintable** (`contrast(on-accent, accent) ≥ 4.5:1`,
  3:1 large). Contrast is the theme's job, computed once — not re-judged per feature.

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

All additive: new `--fb-*` runtime vars + a new `feedBack.theme` namespace + a new event with no
current listeners. Existing plugins (those reading `fb-*` utility classes, or shipping their own
skins) are untouched unless they opt in; two-arg `var(--fb-x, fallback)` + `window.feedBack?.theme?.get`
feature-detection means older hosts behave exactly as today.

**Workstream (sub-tasks):**
1. **Host minimal surface** — always-present default `--fb-*` tokens + `feedBack.theme.{get,capabilities,prefersReducedMotion}` + `theme:changed`. *(the smallest thing that would have prevented the incident)*
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
- Where the central reduced-motion + focus rules physically live (core base layer vs a shared
  plugin import) and how the host injects role tokens into plugin roots.
