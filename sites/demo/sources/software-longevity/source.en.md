# Readable in Ten Years: Static HTML and the Half-Life of Digital Work

> Most personal sites do not die from a lack of ideas — they die from a broken dependency tree. Crystallizing writing and craft as plain standard HTML is the surest hedge against link rot and tooling churn.

## § 01 The Hidden Half-Life of Digital Publishing

Lay out everything you have written and built over the past decade by storage medium, and a quiet law emerges: **the thicker the abstraction stack, the shorter the half-life.**

| Publishing Stack | Typical Half-Life | Primary Failure Mode |
| :--- | :--- | :--- |
| Hosted SaaS Newsletter / Platform | 2 – 5 yrs | Business pivots, paywalls, link rot |
| Database-Backed Dynamic CMS | 3 – 6 yrs | Hosting lapses, plugin security churn |
| Heavy Frontend SSG Pipeline | 2 – 4 yrs | Dependency rot, breaking bundler upgrades |
| **Plain Sources + Standard HTML5** | **20+ yrs** | Evergreen browser compatibility, zero runtime |

- Essays locked inside a proprietary SaaS platform vanish the day business models pivot.
- Database-backed dynamic sites decay the moment hosting lapses or plugin security patches pile up.
- Heavy bundler pipelines with hundreds of transitive packages often refuse to even install locally after twenty-four months untouched.
- **Plain-text sources compiled into standard HTML5, CSS, and vanilla JS** open cleanly thirty years later in any browser on earth.

## § 02 Zero Dependencies No Longer Means Low Craft

Developers once tolerated heavy frontend stacks because the raw web platform lacked ergonomic primitives. By 2026, the browser itself ships nearly everything an independent publication needs:

- Native `@layer` cascade zones and CSS nesting replace preprocessors.
- `light-dark()` and `<meta name="color-scheme">` coordinate light and dark themes cleanly.
- Native `<dialog closedby="any">` handles top-layer focus containment and dismissal without custom traps.
- `@view-transition { navigation: auto; }` brings fluid cross-document transitions to pure static pages.

Building directly on web standards anchors your work to the most backwards-compatible runtime ever engineered.

## § 03 Static Core, Modular Edge

Inside *Tong's Information*, every essay, image plate, and machine manifest lives transparently inside Git and `site/`. It runs off any static host — or directly off a local disk — yet deploying on Cloudflare Workers Static Assets preserves an effortless path to add HTTP content negotiation and Remote MCP tools later without disturbing the static foundation.

**True longevity pairs an unbreakable static core with a modular doorway to the future.**
