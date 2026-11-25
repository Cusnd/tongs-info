# Tong's Information — Swiss Modernist Design Constitution (`DESIGN.md`)

> **Core Ethos**: *Weniger, aber besser* (Less, but better). Hierarchy comes from typography, proportion, alignment, and generous negative space — never from decorative boxes, status ribbons, stickers, or nested borders.

---

## 1. Anti-Over-Decoration Rules (Strict)

1. **No box-in-box chrome**: Never wrap buttons, tags, badges, filter items, or list containers in rectangular borders. Use typography, weight, subtle hover tint, and single `1px` horizontal hairlines only where structural separation is earned.
2. **One quiet canvas**: Avoid checkerboard alternating gray/white slabs. Keep the page on a single calm paper surface (`#FFFFFF` light / `#0D0F13` dark), reserving subtle surface tints only for code blocks and interactive lab specimens.
3. **Zero performative metadata**: No ticker strips, colored status dots, fake print stamps, or boxed spec cards. Show only what helps the reader orient: issue number, date, reading time, language link, and clean action links.
4. **Human visual richness vs. silent machine plumbing**: Because `/llms.txt`, `/api/*.json`, and `index.md` already serve pure high-signal text to Agents (via HTTP `Link` headers, `<link rel="alternate">`, and `robots.txt`), the browser homepage and articles are liberated to be genuinely visual, warm, and art-directed for human eyes — using cohesive Swiss editorial artwork plates, dramatic typographic contrast (oversized issue numerals), asymmetric magazine spreads, and editorial voice, never UI chrome clutter or machine-plumbing promos.
5. **Restrained color**: Monochrome precision ink (`--ink-primary` / `--ink-secondary` / `--ink-muted`) carries 98% of the page. **International Cobalt** (`--accent`) marks active links, focus rings, and key interactive controls; **Vermilion** (`--signal`) appears only inside editorial artwork plates and data visualizations.

---

## 2. Color Tokens (`engine/assets/css/tokens.css`)

| Token | Light Mode | Dark Mode | Role |
| :--- | :--- | :--- | :--- |
| `--bg-canvas` | `#FFFFFF` | `#0D0F13` | Single unified reading canvas |
| `--bg-surface` | `#FFFFFF` | `#12151C` | Elevated dialog / lab specimen surface |
| `--bg-subtle` | `#F4F5F7` | `#171B24` | Code blocks, gentle hover surface |
| `--ink-primary` | `#111318` | `#ECEFF4` | Headlines, body prose |
| `--ink-secondary` | `#4E5666` | `#A2ACBD` | Decks, captions, sidenotes |
| `--ink-muted` | `#747D8F` | `#7A8496` | Dates, issue numbers, metadata |
| `--rule` | `#E5E8EE` | `#232834` | Whisper-thin `1px` structural hairlines |
| `--rule-strong` | `#111318` | `#D8DEE9` | Rare structural emphasis / modal border |
| `--accent` | `#0047FF` | `#689BFF` | Active state, links, primary accent |
| `--accent-soft` | `rgba(0, 71, 255, 0.06)` | `rgba(104, 155, 255, 0.14)` | Subtle hover / active tint |
| `--signal` | `#D9381A` | `#FF6B4E` | Data visualization accent only |

---

## 3. Typography & Bilingual Rhythm

- **Sans (`--font-sans`)**: `"Inter", "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif`
- **Mono (`--font-mono`)**: `"JetBrains Mono", "IBM Plex Mono", "SFMono-Regular", ui-monospace, Consolas, monospace`
- **Editorial Serif (`--font-editorial`)**: `"Newsreader", "Georgia", "Songti SC", "Noto Serif SC", serif` (reserved for pull quotes)
- **Chinese (`lang="zh-Hans"`)**: `line-height: 1.85`, `max-inline-size: 38em`.
- **English (`lang="en"`)**: `line-height: 1.66`, `max-inline-size: 62ch`, `hyphens: auto`.
- Always use ASCII apostrophe (`Tong's Information`) in headings/mastheads so CJK fallback fonts never introduce full-width spacing gaps.

---

## 4. Two-Tier Structure

- **Tier 1 — Essay**: Open typographic title block, inline utility row (`Copy Markdown · .md · Citation · Counterpart`), left section index, crisp prose column, and borderless right-margin sidenotes (`>= 1180px`).
- **Tier 2 — Feature**: Same quiet typographic discipline, adding self-contained interactive laboratories bounded by a single `1px` hairline.

---

## 5. Motion & State Continuity (`editorial/MOTION.md`)

- **Zero Visual Discontinuity**: Every state transition — cross-document navigation, Cover ↔ Inner masthead/header morphs, article cover plate continuity, light/dark theme switching, modal dialogs, archive filtering, scroll progress, TOC tracking, and lab/graph updates — follows `editorial/MOTION.md` and `engine/assets/css/motion.css`.
- **Cascade Order**: `@layer reset, tokens, base, layout, editorial, components, motion, utilities;`.
- **Swiss Kinetic Restraint**: Use `--ease-swiss`, `--ease-enter`, `--ease-exit`, and `--ease-standard` with tokenized durations (`90ms`–`460ms`); opt spatial movement into `@media (prefers-reduced-motion: no-preference)`.
