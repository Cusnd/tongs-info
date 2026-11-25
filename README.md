# Tong's Information

[简体中文](./README.zh-CN.md) | **English**

> A Swiss modernist, zero-build, Agent-native bilingual digital publication — engineered for both human eyes and AI agents.

- **Production Target**: [https://www.esoren.com](https://www.esoren.com) (`Tong's Information`)
- **Demo Showcase Target**: [https://info-demo.esoren.com](https://info-demo.esoren.com) (`Tong's Information - Demo`)

---

## Why This Exists

Most static blogs force every essay through the same rigid template and bury their writing beneath fragile bundler dependency trees. **Tong's Information** flips the model:

- **Zero Build / Zero Frameworks**: Pure HTML5, modern CSS (`@layer`, `light-dark()`, cross-document View Transitions, Scroll-Driven Animations), and vanilla ES modules. Zero runtime npm dependencies.
- **Shared Engine, Multi-Site Repository**: One shared `engine/` (CSS, JS, `_headers`), one shared `editorial/` constitution & partials, one version-controlled site manifest (`sites/sites.json`), and isolated site instances under `sites/demo/` and `sites/prod/`. Improve the engine once — every site upgrades together.
- **Agent-Authored, Source-First**: Write raw notes in `sites/<site>/sources/`; your coding Agent localizes both Chinese & English editions and crafts bespoke HTML pages following `AGENTS.md`, `editorial/DESIGN.md`, and `editorial/MOTION.md`.
- **Two-Tier Publishing**: Tier 1 **Essays** (disciplined Swiss typography with margin sidenotes) + Tier 2 **Features** (art-directed spreads with zero-dependency interactive labs).
- **Dual-Audience Agent Web**: Every issue automatically ships a clean sibling `index.md` twin alongside `/llms.txt`, `/llms-full.txt`, `/api/posts.json`, `/api/graph.json`, `/api/release.json`, RSS 2.0, JSON Feed 1.1, and HTTP `Link: </llms.txt>; rel="describedby"` headers.
- **Cloudflare Workers Static Assets + Dual CI/CD**: Deployed via Cloudflare's pinned `cf` CLI with isolated GitHub Actions pipelines for Demo and Production, complete with audit gates, cross-site Worker guards, immutable staging, and release-digest live smoke tests.

---

## Architecture

```text
Tongs-info/
├── AGENTS.md                       # Agent Editorial Desk constitution & publishing SOP
├── editorial/
│   ├── DESIGN.md                   # Swiss modernist design tokens & anti-decoration rules
│   ├── MOTION.md                   # Five-layer zero-discontinuity motion constitution
│   └── partials/                   # Shared header/footer HTML templates (hydrated per site)
├── engine/                         # Single shared static runtime (no site hardcoding)
│   ├── _headers                    # Cloudflare HTTP headers, UTF-8 & revalidation policy
│   └── assets/                     # Shared CSS, JS, and default favicon.svg
├── sites/
│   ├── sites.json                  # Reviewed site -> Worker / Preview Worker / base_url registry
│   ├── demo/                       # Live showcase: Tong's Information - Demo (info-demo.esoren.com)
│   │   ├── catalog.json
│   │   ├── sources/
│   │   └── public/
│   └── prod/                       # Production site: Tong's Information (www.esoren.com)
│       ├── catalog.json
│       ├── sources/
│       └── public/
├── tools/                          # Zero-dependency Python 3.10+ toolchain
│   ├── _headers_eval.py            # Shared Cloudflare-accurate _headers evaluator (append + detach)
│   ├── editorial_sync.py           # Sync partials, twins & feeds; audit gate; stage bundle + release.json
│   ├── preview_server.py           # Zero-copy local preview server mirroring Cloudflare semantics
│   ├── smoke_test.py               # Local & live HTTP contract + release-digest verification suite
│   └── deploy.py                   # Cross-platform Cloudflare `cf` CLI deployer with registry guards
├── cloudflare.config.ts            # Reads sites/sites.json to target Demo / Prod / Preview Workers
└── .github/workflows/
    ├── ci.yml                      # Fork-safe PR audit + local smoke + isolated trusted-tool PR previews
    ├── deploy-demo.yml             # Auto-deploy Demo on demo/engine changes to main
    ├── deploy-prod.yml             # Auto-deploy Production on prod/engine changes to main
    └── reusable-cf-deploy.yml      # Shared release gate, cross-site guard & live release-digest smoke
```

---

## Quick Start

### Prerequisites

- **Python 3.10+** (zero pip packages required)
- **Node.js `^22.23.0 || ^24.22.0 || ^26.12.0`** (Node 24 LTS recommended; matches pinned `cf@1.0.0-rc.5` engine range; only needed for deploying with `cf`)

### Local Development & Verification

```bash
# 1. Install the pinned `cf` CLI devDependency (only needed for deployment / dry-run)
npm ci

# 2. Sync partials, Markdown twins, Agent manifests & run full audit across all sites
npm run sync

# 3. Run read-only audit gate + stage flat .dist/ bundles + HTTP smoke tests
npm run smoke:demo
npm run smoke:prod

# 4. Preview locally with zero-copy engine/ overlay and exact _headers semantics
npm run preview:demo   # http://127.0.0.1:8788
npm run preview:prod   # http://127.0.0.1:8789
```

### Deploy Manually (Local)

```bash
npx cf auth login
npm run deploy:demo:dry   # Preview Cloudflare Build Output without uploading
npm run deploy:demo       # Deploy Demo -> Worker: tongs-info-demo
npm run deploy:prod       # Deploy Prod -> Worker: tongs-info-prod
```

---

## Forking & Launching Your Own Publication

Because every convention is documented in [`AGENTS.md`](./AGENTS.md) and all site identities live in `sites/sites.json`:

1. Fork or clone this repository.
2. Update `sites/sites.json` with your site name(s), Worker names, and `base_url` (remove the `demo` entry and `sites/demo/` directory if you only want a single production site — `ci.yml` dynamically discovers sites from `sites/sites.json` and `deploy-demo.yml` skips cleanly when `demo` is absent).
3. Point your Agent to `AGENTS.md` to customize `sites/prod/catalog.json`, HTML canonical/title metadata, and `sites/prod/sources/` with your own writing.
4. Run `npm run sync` and `npm run smoke:prod`.
5. Configure GitHub Environments and Cloudflare secrets below, then run your first deployment.

---

## Dual CI/CD Setup (GitHub Actions + Cloudflare Workers)

The repository ships two independent release pipelines plus a security-isolated PR workflow:

- **`ci.yml`** (on PRs to `main`):
  - `discover` + `validate` run on all active sites from `sites/sites.json` with **zero secrets** (100% safe on external Fork PRs).
  - For **same-repository PRs** only, `preview-demo` / `preview-prod` run in **dedicated preview environments** (`preview-demo`, `preview-prod`), check out **trusted `main` tooling**, and publish the pre-validated static bundle to **separate preview Workers** (`tongs-info-demo-preview`, `tongs-info-prod-preview`). PR branches never touch release credentials or release Workers.
- **`deploy-demo.yml`** (on push to `main` touching `sites/demo/**`, `sites/sites.json`, `engine/**`, `editorial/**`, `tools/**`, or config): deploys automatically to Demo (`demo` environment → `tongs-info-demo`).
- **`deploy-prod.yml`** (on push to `main` touching `sites/prod/**`, `sites/sites.json`, `engine/**`, `editorial/**`, `tools/**`, or config): deploys automatically to Production (`production` environment → `tongs-info-prod`).
- Both release workflows serialize per site (`concurrency` with `cancel-in-progress: false`, coalescing rapid queued merges cleanly into the newest release) and enforce `refs/heads/main`.

### 1. Configure GitHub Environments

In **GitHub Repository → Settings → Environments**:

1. Create release environments **`demo`** and **`production`**, and set **Deployment branches and tags** on both to **`main` only**.
2. *(Optional, for PR previews)* Create separate **`preview-demo`** and **`preview-prod`** environments scoped to preview-only Cloudflare Workers (`tongs-info-demo-preview` / `tongs-info-prod-preview`). If omitted, preview jobs skip cleanly without failing PRs.

| Environment | Branch Policy | Type | Key | Value |
| :--- | :--- | :--- | :--- | :--- |
| `demo` | `main` only | Secret | `CLOUDFLARE_API_TOKEN` | Token scoped to Demo Worker (*Workers Scripts: Edit*) |
| `demo` | `main` only | Secret | `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare Account ID |
| `demo` | `main` only | Variable *(optional)* | `CF_WORKER_NAME` | `tongs-info-demo` (validated against `sites/sites.json`) |
| `demo` | `main` only | Variable *(optional)* | `SITE_BASE_URL` | `https://info-demo.esoren.com` (validated against `sites/sites.json`) |
| `production` | `main` only | Secret | `CLOUDFLARE_API_TOKEN` | Dedicated token scoped to Production Worker |
| `production` | `main` only | Secret | `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare Account ID |
| `production` | `main` only | Variable *(optional)* | `CF_WORKER_NAME` | `tongs-info-prod` (validated against `sites/sites.json`) |
| `production` | `main` only | Variable *(optional)* | `SITE_BASE_URL` | `https://www.esoren.com` (validated against `sites/sites.json`) |
| `preview-demo` *(opt)* | PR branches | Secret | `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | Scoped to preview Worker `tongs-info-demo-preview` |
| `preview-prod` *(opt)* | PR branches | Secret | `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | Scoped to preview Worker `tongs-info-prod-preview` |

> **Cross-Site & Stale-Release Protection**: Before upload, CI verifies that `sites/sites.json`, `sites/<site>/catalog.json`, `SITE_BASE_URL`, `CF_WORKER_NAME`, and `.dist/<site>/api/release.json` all agree and rejects any cross-site or preview/release Worker collision. After upload, `smoke_test.py --expect-dist` verifies the live `/api/release.json` `bundle_sha256` and `/api/posts.json` payload match the exact bundle just deployed.

### 2. First-Time Provisioning & Custom Domain Binding

`cloudflare.config.ts` intentionally omits hardcoded custom domains so external forks deploy cleanly out of the box. For the very first deployment before Custom Domains are bound:

1. In GitHub Actions, trigger **`Deploy Demo`** and **`Deploy Production`** manually via **Run workflow** with **`skip_live_smoke = true`** (uploads each Worker for the first time without failing on an unbound custom domain).
2. In **Cloudflare Dashboard → Workers & Pages**:
   - Open **`tongs-info-demo` → Settings → Domains & Routes → Add Custom Domain** → bind `info-demo.esoren.com`.
   - Open **`tongs-info-prod` → Settings → Domains & Routes → Add Custom Domain** → bind `www.esoren.com`.
3. Re-run both workflows with **`skip_live_smoke = false`** to verify live HTTPS delivery, UTF-8 headers, and `api/release.json` digest parity. Subsequent pushes to `main` automatically deploy and verify end-to-end.

---

## Publishing a New Issue with an Agent

1. Drop raw notes or a Markdown draft into `sites/prod/sources/<slug>/source.zh.md` (or `source.en.md`).
2. Prompt your Agent: *"Publish `sites/prod/sources/<slug>/` to `prod` as an Essay (or Feature) following `AGENTS.md`, `editorial/DESIGN.md`, and `editorial/MOTION.md`."*
3. The Agent will localize the counterpart language edition, author both HTML pages in `sites/prod/public/`, update `sites/prod/catalog.json`, and run `npm run sync && npm run smoke:prod`.
4. Commit and push to `main` — `deploy-prod.yml` automatically validates, deploys to `https://www.esoren.com`, and verifies the live release digest without touching Demo.

---

## License

This project uses a clear dual-license model:

- **Code, Engine, Site-Local Lab Scripts/Styles, Design/Motion Specs, Tooling & CI/CD** (`engine/`, `editorial/`, `tools/`, `.github/`, `sites/sites.json`, `sites/*/public/posts/**/*.js`, `sites/*/public/posts/**/*.css`, `AGENTS.md`, `cloudflare.config.ts`, `package.json`): **[MIT License](./LICENSE)**
- **Original Editorial Articles, Bilingual Manuscripts, Derived Syndication Prose & Artwork Plates** (`sites/*/sources/`, editorial prose in `sites/*/public/**/*.html`, `sites/*/public/**/*.md`, `llms*.txt`, `rss.xml`, `feed.json`, `api/*.json`, and `sites/*/public/assets/images/`): **[CC BY 4.0](./LICENSE-CONTENT)**
