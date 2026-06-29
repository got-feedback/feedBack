# Theming a plugin so it works in every theme

This is the how-to for plugin authors. It exists because of one recurring bug:
a plugin's UI is built and eyeballed against the **default** look, ships, and
then a user switches themes and the feature's *colours adapt but its visual
devices vanish* — a glow ring, a colour gradient — because the active theme
doesn't speak that visual language.

**The golden rule:** themes are different **design languages**, not palettes.
Reference **roles** and **recipe slots**; never hardcode a *device* (a literal
`box-shadow` glow, a literal `linear-gradient`, a hex colour). Then your feature
renders correctly in a theme nobody has invented yet — and **verify it across
the whole theme set before you merge.**

(Design + rationale: [host-theme-contract.md](host-theme-contract.md), got-feedback/feedBack#644.)

## What the host gives you

Always-present CSS role tokens on `:root` (resolve themed *or* un-themed):
`--fbv-bg / sidebar / card / cardMuted / primary / primaryHi / accent / text /
textDim / border / good / mid / low / gold`, plus **`--fbv-on-accent`** (a
foreground legible *on* an accent fill) and **`--fbv-focus-ring`**. Use as
`color: rgb(var(--fbv-text))`, `background: rgb(var(--fbv-card))`, etc.

A JS read surface on the event bus:

```js
const t = window.feedBack?.theme;
t?.get();                  // { id, isThemed, tokens }
t?.capabilities();         // { glow, gradients, motion } — what devices this theme permits
t?.prefersReducedMotion(); // boolean (one central matchMedia)
window.feedBack.on('theme:changed', (e) => { /* e.detail = {id, tokens, capabilities} */ });
```

Feature-detect everything (`window.feedBack?.theme?.get`) and pass a fallback to
every `var(--fbv-x, <fallback>)` so you degrade cleanly on an older host.

## Pick your path

### Path A — you do NOT have your own skins (most plugins)

Look like the host. **Derive surfaces from host tokens** and **choose devices
from capabilities** instead of hardcoding them:

```js
const caps = window.feedBack?.theme?.capabilities?.() ?? { glow: true, motion: true };
heroEl.classList.toggle('use-glow', caps.glow && !window.feedBack.theme.prefersReducedMotion());
```
```css
.hero       { background: rgb(var(--fbv-primary)); color: rgb(var(--fbv-on-accent, #fff)); }
.hero:focus-visible { outline: 2px solid rgb(var(--fbv-focus-ring)); outline-offset: 2px; }
.hero.use-glow { box-shadow: 0 0 16px -2px rgb(var(--fbv-primary)); } /* only where the theme allows it */
```
Re-read on `theme:changed` if you cache anything (e.g. a canvas palette).

### Path B — you HAVE your own deliberate skins (like the scoring UI)

Your skins are an identity (neon vs steel vs clean) — **own your surfaces**;
don't inherit host surfaces or you'll erase that identity. Adopt only the
**pattern**: make every visual *device* a **per-skin token whose "off" value is
legal**, so each skin authors its own version and a glow-less skin simply
doesn't glow. Example (the "make the hero special" device):

```css
/* base / neon */         :root      { --hero-ring: .5; --hero-border: transparent; --acc-fill: linear-gradient(135deg, var(--accent), var(--accent2)); }
/* glow-less skin */      [data-skin="clean"] { --hero-ring: 0; --hero-border: var(--accent); --acc-fill: var(--accent); }
.hero        { background: var(--acc-fill); border-color: var(--hero-border); }
.hero::after { opacity: var(--hero-ring); /* the glow ring; 0 = off */ }
```
Neon emphasises with the ring, the clean skin with a solid border — **neither is
empty of emphasis; each speaks its own language.** Same idea for an accent-filled
number (`--acc-fill` = a gradient in one skin, a solid in another so it doesn't
wash out to white). Add `on-accent` + `focus-ring` per skin too.

## Accessibility (part of the contract, not an afterthought)

- **Reduced motion:** gate decorative animation on `prefers-reduced-motion`
  (CSS `@media`, or `theme.prefersReducedMotion()`); functional transitions are fine.
- **Focus:** always a visible `:focus-visible` outline using `focus-ring` — don't
  bind focus only to `accent` (it can ≈ the surface in some themes).
- **On-accent contrast:** text on an accent fill uses `on-accent`; watch light
  accents (a mid-amber needs dark text, not white).

## Before you merge — verify across the matrix

Render your UI in **every** theme/skin and look at them together. If you ship
your own skins, do this with a render-matrix in CI/local (reference: the scoring
UI's `npm run render-skins` + `theme-matrix-checklist.md`). The checklist that
catches this bug class:

- [ ] colours via tokens, no hardcoded hexes
- [ ] rendered in **all** themes/skins (not just the default)
- [ ] every new *device* is per-skin / capability-gated and **legible when its token is `none`**
- [ ] reduced-motion + visible focus in every theme
- [ ] text on accent stays legible everywhere
