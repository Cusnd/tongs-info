---
title: "Beyond Templates: Why Personal Publishing Belongs to Agent-Authored HTML"
publication: "Tong's Information"
author: "Tong"
issue: "01"
tier: "essay"
lang: "en"
date: "2026-10-28"
updated: "2026-11-24"
concepts: ["agent-web", "static-architecture", "swiss-typography", "bilingual-i18n"]
canonical_html: "https://www.esoren.com/en/posts/agent-era-publishing/"
canonical_md: "https://www.esoren.com/en/posts/agent-era-publishing/index.md"
counterpart_md: "https://www.esoren.com/posts/agent-era-publishing/index.md"
---

# Beyond Templates: Why Personal Publishing Belongs to Agent-Authored HTML

> Traditional static site generators were an ergonomic compromise for human hands tired of writing HTML. With an agent at the desk, we can discard brittle build pipelines and reclaim the native medium of the web.

## § 01 Templates Began as Liberation and Ended as a Cage

For the past fifteen years, starting a personal blog followed a nearly universal recipe: pick a static site generator (Hugo, Jekyll, Hexo, or Astro), write Markdown, choose a theme, wire up plugins, and hand the compilation pipeline to CI.

In the era of hand-coded web maintenance, that architecture was completely sensible. Humans hated updating the same navigation bar across fifty HTML files, and nobody enjoyed assembling `rss.xml` or `sitemap.xml` by hand. Template engines traded expressive freedom for lower mechanical labor.

Yet the hidden tax piled up quietly:

1. **Every thought flattened into the same rectangle**: Whether you are publishing a three-hundred-word note or an interactive systems analysis, every piece gets squeezed into an identical Markdown column.
2. **Chronic dependency rot**: Return to a blog after eighteen months to tweak one typographic rule, and you often spend an evening fighting breaking framework upgrades, Node versions, and stale bundler plugins.
3. **The wall of bilingual publishing**: Maintaining a Chinese–English blog in traditional setups quickly becomes an ordeal of brittle i18n routing tables and manual translation fatigue, driving most personal sites back to a single language.

## § 02 When an Agent Joins the Editorial Desk

In the agent era, the marginal cost of authoring clean semantic HTML, tuning modular CSS grids, crafting zero-dependency interactive demonstrations, and localizing ideas thoughtfully across languages approaches zero.

That inversion lets us ask a question that felt extravagant a decade ago: **What does personal publishing look like when every essay has an art director, a typesetter, and a bilingual editor standing by?**

At *Tong's Information*, our answer rests on three architectural pillars:

### 1. Keep Plain-Text Sources; Liberate the HTML Edition

Raw thinking still lives as clean Markdown inside `sources/`. That preserves a durable, lossless Source of Truth that any future tool or redesign can read cleanly ten years from now.

Between `sources/` and `site/`, however, sits an **agent editorial desk** rather than a rigid template compiler:

- **Tier 1 — Essays & Notes**: Disciplined Swiss typography, structured section markers, and desktop margin sidenotes — ready to publish in minutes.
- **Tier 2 — Features & Interactives**: Art-directed flagship spreads with bespoke diagrams, custom visual rhythms, and self-contained vanilla JS laboratories embedded directly in static HTML.

### 2. Defeat Style Entropy with an Explicit Order Layer

Letting an AI write arbitrary HTML from scratch session after session guarantees drift: after twenty posts, spacing, type scales, and DOM structure splinter apart. The answer is not retreating to a heavy framework, but encoding **taste and invariants as machine-readable specifications**:

- `editorial/DESIGN.md` defines the modular grid, color tokens, bilingual typographic rhythm, and contrast rules.
- `AGENTS.md` documents the publishing protocol and accessibility baseline.
- A tiny, zero-dependency Python script (`tools/editorial_sync.py`) owns every **deterministic task**: syncing header/footer partials, mirroring clean `index.md` twins, generating `llms.txt`, RSS, JSON Feed, and the concept graph, and auditing links and metadata before deployment.

**Give creative work to probabilistic intelligence; give invariants to deterministic scripts.** That is the true equilibrium of agent-native engineering.

### 3. Bilingual by Default, Not an Afterthought

Traditional i18n feels like a tax because humans pay every marginal translation hour. In an agent-native workflow, drafting in whichever language fits your thought yields a carefully edited counterpart edition in minutes — complete with bidirectional `hreflang` links, dual-language feeds, and script-aware typography (generous line height and open rhythm for Chinese; tight display tracking and hyphenation for English).

## § 03 Static Longevity

No `node_modules` required to render a sentence. No database to patch. No frontend framework churn.

The web browser remains the most backwards-compatible runtime ever built. Clean HTML5 paired with modern CSS (`@layer`, `light-dark()`, native `<dialog>`, and cross-document View Transitions) delivers instant performance today and remains effortlessly legible ten years from now — both to human eyes and to the next generation of AI agents.

This is Issue 01 of *Tong's Information*, and the foundation of the desk.
