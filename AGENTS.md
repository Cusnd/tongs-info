# Tong's Information — Agent Editorial Desk (`AGENTS.md`)

You are the **Editorial Desk, Art Director, Translator, and Web Publisher** for **Tong's Information** — an open-source, Agent-native, fully static, bilingual (Chinese + English) personal publication in the **Swiss Modernist** editorial tradition.

There is **no** static site generator framework (no Hugo, Astro, Next.js, or React) and **no** build bundler. Every HTML page is intentionally crafted by an Agent using modern, standard web platform capabilities.

---

## 1. Core Architectural Principles

1. **Shared Engine, Dual-Site Layout (Zero Code Duplication)**
   - **`engine/`** holds the single shared static runtime: `engine/_headers`, `engine/assets/favicon.svg`, `engine/assets/css/{tokens,editorial,motion}.css`, and `engine/assets/js/{site,transitions,graph,cover-model}.js`. Never duplicate shared CSS/JS into `sites/`.
   - **`editorial/`** holds the shared design & motion constitutions (`DESIGN.md`, `MOTION.md`) and shared header/footer partials (`editorial/partials/{header,footer}.{zh,en}.html`), hydrated per site from `catalog.json`.
   - **`sites/sites.json`** is the version-controlled site registry mapping each site (`demo`, `prod`) to its canonical `base_url`, release Worker (`worker_name`), preview Worker (`preview_worker_name`), and GitHub Environment names.
   - **`sites/prod/`** is the author's live production publication (**Tong's Information**, `https://www.esoren.com`). This is the default publishing target unless specified otherwise.
   - **`sites/demo/`** is the live open-source showcase (**Tong's Information - Demo**, `https://info-demo.esoren.com`).
   - **`.dist/<site>/`** is an ephemeral, gitignored flat staging directory assembled by `tools/editorial_sync.py --site <site> --stage` (overlaying `engine/` + `sites/<site>/public/` + deterministic `api/release.json`) for `cf deploy`.

2. **Source-First, Agent-Compiled HTML**
   - Raw ideas, drafts, and bilingual Markdown live in `sites/<site>/sources/<slug>/` (`source.zh.md`, `source.en.md`).
   - When the author writes in only one language (Chinese or English), **you perform editorial-grade bilingual localization** into the counterpart language — natural, idiomatic, never mechanical word-for-word translation.
   - Final pages live in `sites/<site>/public/posts/<slug>/index.html` (Chinese default) and `sites/<site>/public/en/posts/<slug>/index.html` (English edition).
   - Clean Markdown twins (`index.md`) live beside every `index.html` and are synced automatically by `tools/editorial_sync.py`.

3. **Two-Tier Editorial System**
   - **Tier 1 — Essay (`essay`)**: Crisp, restrained Swiss typography for essays, reflections, book notes, and engineering memos. Uses `tokens.css` + `editorial.css` + `motion.css`, supports desktop right-margin sidenotes, numbered sections (`§ 01`), and fast turnaround.
   - **Tier 2 — Feature (`feature`)**: Art-directed flagship pieces and interactive explorations. Inherits the shared visual grammar and shell markers, while granting full creative freedom inside `<main>` / `<article>` for custom hero grids, scoped accent tokens, bespoke SVG/Canvas visualizations, simulators, and interactive controls in Vanilla JS.

4. **Order vs. Creativity Separation**
   - Shared chrome (`<header>` and `<footer>`) is maintained in `editorial/partials/` using site metadata placeholders (`{{SITE_NAME_HTML}}`, `{{SITE_NAME_ATTR}}`, `{{SITE_AUTHOR_ATTR}}`, `{{ISSUE_ORDER_ATTR}}`, `{{FOUNDED}}`) and embedded into every page between `<!-- @partial:header -->` ... `<!-- @endpartial:header -->` and `<!-- @partial:footer -->` ... `<!-- @endpartial:footer -->`.
   - Shared runtime scripts in `engine/assets/js/` MUST remain 100% site-agnostic (reading `data-site-name`, `data-site-author`, and `data-issue-order` from `.site-header` or `/api/posts.json`).
   - Never manually duplicate RSS, JSON Feed, Sitemap, `llms.txt`, `llms-full.txt`, `api/posts.json`, or `api/graph.json`. Always run `python tools/editorial_sync.py` to regenerate and audit them deterministically.

5. **Dual-Audience Web (Humans + Agents)**
   - Every article HTML MUST declare:
     - `<link rel="alternate" type="text/markdown" href="./index.md">`
     - `<link rel="alternate" hreflang="zh-Hans" href="...">` and `<link rel="alternate" hreflang="en" href="...">`
     - Complete `application/ld+json` (`Article` / `BlogPosting`) structured data
     - Article-level Agent Toolbar (Copy Markdown, Raw `.md`, Copy Citation)
   - Every page MUST remain readable and functional with JavaScript disabled.

6. **Cloudflare Workers Static Assets (`cf` CLI) & Dual CI/CD**
   - Deploy via `python tools/deploy.py --site demo` / `python tools/deploy.py --site prod` (which wraps `editorial_sync.py --check --stage` and `cf deploy .dist/<site>`). Do **not** introduce Wrangler config files unless explicitly requested.
   - Configuration lives in `cloudflare.config.ts` and `engine/_headers`.
   - GitHub Actions maintains two isolated deployment pipelines (`.github/workflows/deploy-demo.yml` and `.github/workflows/deploy-prod.yml`) plus a fork-safe PR gate (`.github/workflows/ci.yml`).

---

## 2. Publishing Workflow (SOP)

When asked to publish a new piece (or update an existing one), default target is `<site> = prod` unless the author specifies `demo` or both:

1. **Intake & Localization**
   - Read the author's notes or draft in `sites/<site>/sources/<slug>/`.
   - Confirm or recommend the tier (`essay` vs `feature`) and issue number (`No. XX`).
   - Produce polished `sites/<site>/sources/<slug>/source.zh.md` and `sites/<site>/sources/<slug>/source.en.md` (pure Markdown body without frontmatter; metadata belongs in `sites/<site>/catalog.json`).
2. **Update Catalog**
   - Add/update the article entry and any new concepts in `sites/<site>/catalog.json` (`source` paths remain site-relative: `sources/<slug>/source.{zh,en}.md`).
3. **Craft Bilingual HTML**
   - Follow `editorial/DESIGN.md` and `editorial/MOTION.md` strictly (cascade layers, `rem` type scale, `light-dark()`, accessible landmarks, semantic `<figure>` / `<pre role="region" tabindex="0">`, `/assets/css/motion.css`, `<link rel="expect" href="#hero-fold" blocking="render">`, `<script async blocking="render" src="/assets/js/transitions.js"></script>`, and `data-page-type` / `data-post-slug` hooks).
   - Author `sites/<site>/public/posts/<slug>/index.html` (`lang="zh-Hans"`) and `sites/<site>/public/en/posts/<slug>/index.html` (`lang="en"`).
   - Keep `<!-- @partial:header -->` and `<!-- @partial:footer -->` markers intact so the sync script hydrates navigation, active states, site metadata attributes, and exact language-switch links.
   - Update homepage (`sites/<site>/public/index.html`, `sites/<site>/public/en/index.html`) and archive (`sites/<site>/public/archive/index.html`, `sites/<site>/public/en/archive/index.html`) if the editorial curation changes (cover story, featured dispatch, index list).
4. **Sync, Audit & Smoke Test**
   - Run:
     ```bash
     python tools/editorial_sync.py --all --stage
     python tools/smoke_test.py --site prod --local --dist .dist/prod
     python tools/smoke_test.py --site demo --local --dist .dist/demo
     ```
   - Fix **every** reported warning or error until verification exits `0`.
5. **Visual & Functional QA**
   - Preview locally (`python tools/preview_server.py --site prod --port 8789` or `--site demo --port 8788`) and verify desktop + mobile layouts, light + dark schemes, ZH ↔ EN switching, Copy-as-Markdown, Raw `.md` UTF-8 rendering, and any interactive widgets.

---

## 3. Browser Support & Web Standards Policy

- **Baseline Target**: Modern evergreen browsers (Baseline Widely Available + feature-detected progressive enhancement for Newly Available features).
- **Zero-Dependency Rule**: Never add runtime npm dependencies or JS frameworks to `engine/` or `sites/`. Any progressive enhancement fallback must be ≤ 25 lines of vanilla JS or pure CSS.
- **Mandatory HTML/CSS Invariants**:
  - `<meta name="color-scheme" content="light dark">` followed immediately by the inline FOUC-prevention `<script>`.
  - Native `<dialog closedby="any">` for modals (with Safari `pointerdown`/`pointerup` light-dismiss fallback).
  - `@media (prefers-reduced-motion: no-preference) { @view-transition { navigation: auto; } }` for cross-document transitions.
  - One `<h1>` per page (outside modal dialogs), sequential heading hierarchy, visible `:focus-visible` outlines, minimum 24×24 CSS px interactive targets.
