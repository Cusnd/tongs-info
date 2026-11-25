# Tong's Information — Swiss Modernist Motion Constitution (`MOTION.md`)

> **Core Principle**: *Zero visual discontinuity.* Every change in visual state — across documents, within layouts, on scroll, across themes, inside overlays, or inside interactive laboratories — transitions smoothly through a single restrained Swiss kinetic grammar.

---

## 1. Motion Ethos

- **Architectural, Never Theatrical**: Motion follows the physics of precision drafting instruments and Swiss railway clocks — crisp acceleration, calm exponential deceleration, zero gratuitous rubbery bounce on editorial chrome (elastic springs remain reserved for physical objects like the Cover kinetic focal disc).
- **Spatial Continuity First**: When an element changes position, size, or surface between states (e.g., Cover masthead ↔ Header wordmark, wide Cover header ↔ centered Article header, Cover plate ↔ Article hero plate, Archive list filtering, active tab underline), the eye should track the object continuously rather than seeing a hard cut.
- **Compositor-First Performance**: Animate `opacity`, `transform` (`translate`, `scale`, `rotate`), `clip-path`, and View Transition snapshots whenever possible; use CSS Scroll-Driven Animations (`scroll()`, `view()`) instead of JS scroll loops where supported.
- **Universal Reduced-Motion Discipline**:
  - Never use a global `* { animation-duration: 0.01ms !important; }` reset.
  - Opt into spatial displacement, scaling, morphs, and scroll reveals inside `@media (prefers-reduced-motion: no-preference)`.
  - Preserve gentle non-spatial state feedback (ink color, hairline opacity, short fades) under `@media (prefers-reduced-motion: reduce)`, and guarantee every element always rests in its visible final state.

---

## 2. Motion Tokens (`engine/assets/css/tokens.css`)

| Token | Value | Role |
| :--- | :--- | :--- |
| `--duration-instant` | `90ms` | Tactile press, active micro-feedback |
| `--duration-fast` | `150ms` | Hover ink shifts, link underlines, arrow glides, copy pulse |
| `--duration-base` | `240ms` | Tab/filter indicator glides, TOC marker, sidenote affinity, toggle swaps |
| `--duration-moderate` | `340ms` | Dialog top-layer enter/exit, archive rearrangement, page cross-glides |
| `--duration-deliberate` | `460ms` | Hero shared-element morphs (masthead ↔ wordmark, cover plate ↔ hero plate), theme ink-wash |
| `--stagger-step` | `36ms` | Sibling list/card entrance cadence |
| `--ease-swiss` | `cubic-bezier(0.2, 0, 0, 1)` | Signature Swiss morph & deceleration curve |
| `--ease-enter` | `cubic-bezier(0.16, 1, 0.3, 1)` | Arrival deceleration — elements settle silently into place |
| `--ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | Clean departure acceleration |
| `--ease-standard` | `cubic-bezier(0.32, 0, 0.15, 1)` | Symmetric lateral glides (nav indicators, tabs, filter shifts) |
| `--motion-shift-sm` | `6px` | Subtle vertical settle (dialogs, captions, tooltips, language switch) |
| `--motion-shift-md` | `16px` | Editorial scroll reveals & list entry |
| `--motion-shift-lg` | `24px` | Cross-document directional page glides |

---

## 3. Five-Layer Animation Architecture (`engine/assets/css/motion.css` + `transitions.js` + `site.js`)

### Layer 1 — Cross-Document Navigation & Structural Morphs (MPA View Transitions)
Every HTML page inlines `<style>@media (prefers-reduced-motion: no-preference){@view-transition{navigation:auto;}}</style>` in `<head>` (so slow external stylesheets never cause missed MPA opt-in), stabilizes above-the-fold snapshots via `<link rel="expect" href="#hero-fold" blocking="render">`, and loads `<script async blocking="render" src="/assets/js/transitions.js"></script>` in `<head>`.

- **Header & Masthead Continuity**:
  - `site-header`: morphs background (`--cover-paper` ↔ `--bg-canvas`), vertical rhythm, and bottom hairline (`transparent` ↔ `1px solid var(--rule)`).
  - `site-brand`: `.cover-masthead` on Cover morphs smoothly into `.brand-wordmark` in the inner header (and reverses on return to Cover) using a sequential typographic cross-fade so uppercase and mixed-case glyphs never double-expose. If the cover masthead is scrolled out of the viewport during `pageswap`, `transitions.js` clears its transition name so the brand enters cleanly without flying from off-screen.
  - `site-nav`: `.primary-nav > ul` (`inline-size: fit-content`) glides horizontally without aspect-ratio distortion as `.brand-mark` enters or leaves.
  - `site-controls`: `.header-controls` (`inline-size: fit-content`) glides cleanly between the `112rem` cover frame and the `74rem` inner shell.
  - `nav-indicator`: `1.5px` International Cobalt border beneath `a[aria-current="page"]` glides horizontally across Cover / Archive / Graph / About, collapses cleanly (`scaleX(0)`) when entering an article, and draws back in (`scaleX(0 → 1)`) when returning to a top-level section.
- **Viewport-Bounded Page Flow & Article Continuity (`pageswap` + `pagereveal`)**:
  - Directional page glides animate the viewport-sized `root` snapshot (never a multi-thousand-pixel scrolled `<main>`), eliminating cross-viewport scroll jumps while keeping header and shared-element groups layered above.
  - Navigating **Cover / Archive → Article** (`to-article`): dynamically assigns `article-plate` (using Cover's identical print plate `img[data-cover-fallback]` during handoff), `article-title`, and `article-meta` to the clicked visible card/row and its matching hero targets on the destination article, persisting the entry role for faithful Back navigation and cleaning up in `viewTransition.finished` to preserve `bfcache`.
  - Navigating **Article → Cover / Archive** (`from-article`): reverses the morph back into the matching entry/card/row if meaningfully visible in the viewport; on Cover, `cover-model.js` waits for reveal completion before cross-fading the live Canvas over the print plate.
  - Navigating **Article → Article** (`article-next` / `article-prev` / `article-switch`): smooth lateral editorial glide on `root` while keeping the header locked (`ISSUE_ORDER` auto-synced from `data/catalog.json`).
  - Navigating **Cover ↔ Archive ↔ Graph ↔ About** (`nav-forward` / `nav-backward`): subtle directional glide computed from tab order (`0 → 3`).
  - Switching **ZH ↔ EN** (`lang-switch`): calm optical cross-dissolve with subtle `6px` settle while preserving shared reading section `#hash` anchors and Archive filters.

### Layer 2 — Theme & Surface Continuity (Light ↔ Dark)
- Clicking `[data-theme-toggle]` triggers a `document.startViewTransition({ types: ["theme-switch"] })` circular ink-wash clip-path expanding from the button's pointer coordinates (while disabling sub-element and pseudo-element transition names AND pausing surface CSS transitions under `html[data-vt-mode="theme-switch"]` so paper, chrome, images, toggle labels, and Canvas all land on the final theme color before `ready`).
- Under `prefers-reduced-motion: reduce` or unsupported browsers, theme tokens transition smoothly via CSS color/background/border/filter transitions, and the toggle button cross-fades cleanly between `暗色`/`浅色` (`Dark`/`Light`) using a stacked inline grid instead of `display: none`.
- Canvas visualizations (`cover-model.js`, `graph.js`) interpolate RGB palette tokens smoothly on OS theme switch and commit immediately on `theme-switch` View Transitions or reduced-motion toggles.

### Layer 3 — Top-Layer Overlays (`<dialog id="command-palette">` & `#copy-fallback-dialog`)
- Uses `@starting-style`, `transition-behavior: allow-discrete` (declared separately after `transition`), and `overlay` for native entry/exit transitions on both the dialog surface and `::backdrop`.
- Ships a runtime `canTransitionDisplay()` probe, unified `bindDialog()` helper, and operation-sequenced `closeTopLayer()` `[data-closing]` fallback for Safari/Firefox so exit animations never snap shut and rapid `Ctrl+K` re-opens cleanly.
- Live search results in `#palette-results` stagger in once on open (`data-stagger="open"`) and reconcile existing DOM nodes in place while typing (`data-stagger="filter"`) so visible results never flicker to `opacity: 0`.

### Layer 4 — In-Page State & Scroll Choreography
- **Archive Filtering**: Uses `document.startViewTransition` (`types: ["archive-filter"]`) with dynamically assigned per-slug `view-transition-name`, shared `view-transition-class: archive-row`, and `archive-footer` continuity (`pointer-events: none` on `::view-transition`, `:root` transition disabled during filter) so rows and footer glide into new positions while adjacent visible dividers stay flush. Falls back to `@starting-style` + `[data-closing]` exit when View Transitions are unavailable.
- **Cross-Engine Sliding Indicators**: `.filter-group`, `.lab-tabs`, and active `.toc-list` links use a lightweight shared geometry-driven sliding indicator in `site.js` (smooth across Chrome, Edge, Firefox, and WebKit including wrapped flex lines), with pure-CSS Anchor Positioning and static borders as no-JS progressive fallback.
- **Scroll-Driven Animations**:
  - `.reading-progress-fill` uses native `animation-timeline: scroll(root block)` inside `@supports (animation-timeline: scroll())` with a gated `requestAnimationFrame` fallback in `site.js`.
  - Below-the-fold editorial blocks (`.inside-band`, `.feature-plate-card`, `.feature-lab`, `.article-footer-band`, `.prose figure`, `.prose blockquote`) reveal gently with `animation-timeline: view()` (`animation-range: entry 0% entry 26%`) and a lightweight `IntersectionObserver` fallback.
- **Reading Aids & Labs**:
  - TOC rail tracks the active heading via `IntersectionObserver` (`aria-current="location"`), gliding a cobalt vertical indicator along the rail; `:target` sections display a quiet accent hairline pulse.
  - Hovering a `.sidenote-anchor` lifts its margin `.sidenote` ink contrast cleanly.
  - Copy buttons (`data-copy-md`, `data-copy-cite`) animate confirmation state via `[data-copied="true"]`.
  - Interactive Labs (`dual-audience-web`, `ambient-interfaces`, `bilingual-thought`) and Knowledge Graph (`graph.js`) animate tab switches, meter updates, hover/selection Canvas states, pulse rings, and inspector swaps smoothly.

### Layer 5 — Micro-Interactions
- Links, arrows (`→`, `↓`, `↗`), editorial plates, cover inside list rows, and buttons respond with crisp `150ms` ink, underline, micro-translate, and active-press feedback.
- `:focus-visible` transitions `outline-offset` cleanly for deliberate keyboard tracking.

---

## 4. Authoring Checklist for New Issues

When publishing a new issue HTML page, include:
1. `<style>@media (prefers-reduced-motion: no-preference){@view-transition{navigation:auto;}}</style>` right after the `<meta name="color-scheme">` FOUC script in `<head>`.
2. `<link rel="stylesheet" href="/assets/css/motion.css">` right after `editorial.css`.
3. `<link rel="preload" as="image" href="/assets/images/<plate>.jpg" fetchpriority="high">` on articles with a cover plate.
4. `<link rel="expect" href="#hero-fold" blocking="render">` and `<script async blocking="render" src="/assets/js/transitions.js"></script>` in `<head>`.
5. `data-page-type="article" data-post-slug="<slug>"` on `<body>`, and `id="hero-fold"` on `<header class="article-hero">`.
6. `data-post-slug="<slug>"` on any Cover card or Archive row linking to that issue, then run `python tools/editorial_sync.py` to auto-sync `ISSUE_ORDER` and verify all motion invariants.
