# Tong's Information

**简体中文** | [English](./README.md)

> 一份写给人类眼睛与 AI Agent 的瑞士现代主义双语数字刊物 —— 纯静态、零构建、单引擎双站点开源出版架构。

- **正式站目标域名**：[https://www.esoren.com](https://www.esoren.com)（`Tong's Information`）
- **演示站目标域名**：[https://info-demo.esoren.com](https://info-demo.esoren.com)（`Tong's Information - Demo`）

---

## 核心特性

- **零构建 / 零框架**：100% 标准 HTML5、现代 CSS（`@layer`、`light-dark()`、跨文档 View Transitions、Scroll-Driven Animations）与原生 ES Modules，零运行时前端依赖。
- **单仓库 · 单引擎 · 双站点**：全仓只维护**一份** `engine/`（样式、脚本、`_headers`）、`editorial/`（设计/动效宪法与页眉页脚模板）以及受版本控制的站点注册表 `sites/sites.json`；内容层拆分为 `sites/demo/` 与 `sites/prod/`。迭代引擎一次，演示站与正式站同步受益，零代码重复。
- **Agent 原生双语出版**：在 `sites/<site>/sources/` 写下中文或英文原始草稿，由 AI Agent 遵循 `AGENTS.md`、`editorial/DESIGN.md` 与 `editorial/MOTION.md` 完成地道双语本地化并直接编排 HTML。
- **双轨刊物层级**：Tier 1 **Essay**（克制瑞士排印 + 桌面端右侧边注）与 Tier 2 **Feature**（独立美术指导 + 零依赖交互实验装置）。
- **双面万维网（Humans + Agents）**：每期自动派生洁净 `index.md` 孪生原稿，并确定性生成 `/llms.txt`、`/llms-full.txt`、`/api/posts.json`、`/api/graph.json`、`/api/release.json`、RSS 2.0、JSON Feed 1.1 与全站 `Link: </llms.txt>; rel="describedby"` 响应头。
- **Cloudflare Workers Static Assets + 双套 CI/CD**：基于锁定版本的 Cloudflare `cf` CLI，内置 Demo 与 Production 两套隔离流水线，涵盖全量静态审计、跨站 Worker 与域名双防串台守卫、不可变产物拼装与线上发布摘要冒烟校验。

---

## 目录结构

```text
Tongs-info/
├── AGENTS.md                       # Agent 编辑部宪法与双语发文 SOP
├── editorial/
│   ├── DESIGN.md                   # 瑞士现代主义视觉设计宪法
│   ├── MOTION.md                   # 五层零断层动效宪法
│   └── partials/                   # 共享页眉/页脚模板（按站点 catalog.json 自动渲染）
├── engine/                         # 唯一共享代码引擎（零站点硬编码）
│   ├── _headers                    # Cloudflare 响应头、UTF-8 与重验证缓存策略
│   └── assets/                     # 共享 CSS、JS 与默认 favicon.svg
├── sites/
│   ├── sites.json                  # 受控站点注册表（站点 -> Worker / 预览 Worker / base_url）
│   ├── demo/                       # 演示站：Tong's Information - Demo (info-demo.esoren.com)
│   │   ├── catalog.json
│   │   ├── sources/
│   │   └── public/
│   └── prod/                       # 正式站：Tong's Information (www.esoren.com)
│       ├── catalog.json
│       ├── sources/
│       └── public/
├── tools/                          # 零依赖 Python 3.10+ 确定性工具链
│   ├── _headers_eval.py            # 共享 Cloudflare `_headers` 规则求值器（append + detach）
│   ├── editorial_sync.py           # 同步 partials/孪生原稿/协议文件、全站审计、拼装产物与 release.json
│   ├── preview_server.py           # 零拷贝叠加 engine/ 的本地预览服务（严格对齐 Cloudflare 语义）
│   ├── smoke_test.py               # 本地与线上 HTTP 契约 + 发布摘要冒烟测试
│   └── deploy.py                   # 跨平台 Cloudflare `cf` CLI 部署启动器（含跨站 Worker 校验与本地锁）
├── cloudflare.config.ts            # 读取 sites/sites.json 自动切换 Demo / Prod / Preview Worker
└── .github/workflows/
    ├── ci.yml                      # Fork 安全 PR 门禁 + 本地冒烟 + 受信任工具隔离 PR 预览
    ├── deploy-demo.yml             # Demo 站自动部署流水线（合并 main 自动上线）
    ├── deploy-prod.yml             # 正式站自动部署流水线（合并 main 自动上线）
    └── reusable-cf-deploy.yml      # 共享部署、跨站/域名双守卫与线上摘要冒烟工作流
```

---

## 快速开始

### 环境要求

- **Python 3.10+**（纯标准库，无需安装任何 pip 包）
- **Node.js `^22.23.0 || ^24.22.0 || ^26.12.0`**（推荐 Node 24 LTS，与锁定的 `cf@1.0.0-rc.5` 兼容；仅部署时需要）

### 本地开发与验证

```bash
# 1. 安装锁定版本的 Cloudflare `cf` CLI 开发依赖
npm ci

# 2. 同步两站的页眉页脚、Markdown 孪生原稿、llms.txt/RSS/Sitemap 并执行全站审计
npm run sync

# 3. 拼装发布产物 .dist/ 并运行本地 HTTP 契约冒烟测试
npm run smoke:demo
npm run smoke:prod

# 4. 启动本地零拷贝预览服务器（自动叠加 engine/ 并严格模拟 _headers 与 307 重定向）
npm run preview:demo   # http://127.0.0.1:8788
npm run preview:prod   # http://127.0.0.1:8789
```

### 手动部署（本地）

```bash
npx cf auth login
npm run deploy:demo:dry   # 演练构建输出（不上传线上资源）
npm run deploy:demo       # 部署 Demo -> Worker: tongs-info-demo
npm run deploy:prod       # 部署正式站 -> Worker: tongs-info-prod
```

---

## 两套 CI/CD 配置指南（GitHub Actions + Cloudflare Workers）

仓库内置两套按路径精准触发、且与 PR 预览权限彻底隔离的发布流水线：

- **仅改 `sites/prod/**`**：只触发 `deploy-prod.yml`，合并 `main` 后直接自动上线正式站，不打扰 Demo。
- **仅改 `sites/demo/**`**：只触发 `deploy-demo.yml`，只更新 Demo。
- **改动 `engine/**`、`editorial/**`、`tools/**`、`sites/sites.json` 或配置**：`deploy-demo.yml` 与 `deploy-prod.yml` **并行触发**，两站同步升级（同一站点的连续合并通过 `concurrency` 自动串行并合并排队至最新提交）。
- **PR 门禁与安全隔离（`ci.yml`）**：
  - 所有 PR（含外部 Fork PR）均在**零 Secrets** 下完成两站全量审计、本地契约测试与 dry-run。
  - 仅同仓 PR 会触发预览，且预览任务运行在独立的 **`preview-demo` / `preview-prod`** 环境、检出**受信任 `main` 的部署脚本与配置**、仅上传预校验静态产物至独立预览 Worker（`tongs-info-demo-preview` / `tongs-info-prod-preview`），**绝不接触正式站凭据或正式 Worker**。

### 1. 在 GitHub 配置 Environments

打开仓库 **Settings → Environments**：

1. 新建发布环境 **`demo`** 与 **`production`**，并将两者的 **Deployment branches and tags** 均限制为 **仅限 `main` 分支**。
2. *（可选，如需 PR 预览）* 另建 **`preview-demo`** 与 **`preview-prod`** 环境并配置仅限预览 Worker 的凭据；若暂不配置，PR 预览步骤会自动跳过且不影响 CI 通过。

| Environment | 分支限制 | 类型 | 名称 | 推荐值 |
| :--- | :--- | :--- | :--- | :--- |
| `demo` | 仅限 `main` | Secret | `CLOUDFLARE_API_TOKEN` | 仅作用于 Demo Worker 的 API Token |
| `demo` | 仅限 `main` | Secret | `CLOUDFLARE_ACCOUNT_ID` | 你的 Cloudflare Account ID |
| `demo` | 仅限 `main` | Variable *（可选）* | `CF_WORKER_NAME` | `tongs-info-demo`（受 `sites/sites.json` 校验） |
| `demo` | 仅限 `main` | Variable *（可选）* | `SITE_BASE_URL` | `https://info-demo.esoren.com`（受 `sites/sites.json` 校验） |
| `production` | 仅限 `main` | Secret | `CLOUDFLARE_API_TOKEN` | 仅作用于正式站 Worker 的独立 API Token |
| `production` | 仅限 `main` | Secret | `CLOUDFLARE_ACCOUNT_ID` | 你的 Cloudflare Account ID |
| `production` | 仅限 `main` | Variable *（可选）* | `CF_WORKER_NAME` | `tongs-info-prod`（受 `sites/sites.json` 校验） |
| `production` | 仅限 `main` | Variable *（可选）* | `SITE_BASE_URL` | `https://www.esoren.com`（受 `sites/sites.json` 校验） |
| `preview-demo` *（可选）* | PR 分支 | Secret | `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | 仅作用于预览 Worker `tongs-info-demo-preview` |
| `preview-prod` *（可选）* | PR 分支 | Secret | `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | 仅作用于预览 Worker `tongs-info-prod-preview` |

> **跨站防串台与线上版本摘要校验**：部署前 CI 会联合核对 `sites/sites.json`、`catalog.json`、`SITE_BASE_URL`、`CF_WORKER_NAME` 与拼装产物中的 `api/release.json`，拦截任何跨站 Worker 错配或预览/正式混用；部署后 `smoke_test.py --expect-dist` 会比对线上 `/api/release.json` 的 `bundle_sha256` 与 `/api/posts.json` 完整内容，确保线上真实生效的是本次新版本而非旧缓存。

### 2. 首次上线与自定义域名绑定顺序

为确保开源复刻零冲突，`cloudflare.config.ts` 不硬编码个人域名。首次初始化部署建议按以下 3 步操作：

1. 在 GitHub Actions 中分别手动点击 **`Deploy Demo`** 和 **`Deploy Production`** → **Run workflow**，勾选 **`skip_live_smoke = true`** 完成首次 Worker 创建与上传（避免尚未绑定自定义域名时线上冒烟报错）。
2. 在 **Cloudflare Dashboard → Workers & Pages** 一次性绑定域名：
   - **`tongs-info-demo` → Settings → Domains & Routes → Add Custom Domain** → 绑定 `info-demo.esoren.com`。
   - **`tongs-info-prod` → Settings → Domains & Routes → Add Custom Domain** → 绑定 `www.esoren.com`。
3. 再次以 **`skip_live_smoke = false`** 运行两套工作流，确认线上域名 HTTPS、UTF-8 响应头与 `api/release.json` 摘要全部验证通过。之后每次合并 `main` 即可全自动上线与校验。

---

## 日常使用 Agent 发新文章

1. 把原始想法或 Markdown 草稿放进 `sites/prod/sources/<slug>/source.zh.md`（或 `source.en.md`）。
2. 告诉 Agent：*“请按照 `AGENTS.md`、`editorial/DESIGN.md` 和 `editorial/MOTION.md`，将 `sites/prod/sources/<slug>/` 作为 Essay（或 Feature）发布到 `prod` 站。”*
3. Agent 自动完成双语本地化、编写双语 HTML、更新 `sites/prod/catalog.json`，并运行 `npm run sync && npm run smoke:prod`。
4. 提交并 push 到 `main` —— `deploy-prod.yml` 自动完成审计、部署至 `https://www.esoren.com` 及线上摘要冒烟校验，不触发 Demo。

---

## 开源协议（双授权）

- **代码、引擎样式/脚本、文章交互实验脚本/样式、设计/动效规范、工具链与 CI/CD**（`engine/`、`editorial/`、`tools/`、`.github/`、`sites/sites.json`、`sites/*/public/posts/**/*.js`、`sites/*/public/posts/**/*.css`、`AGENTS.md`、`cloudflare.config.ts`、`package.json`）：**[MIT License](./LICENSE)**
- **原创文章、双语译文、派生订阅/语料正文与专题配图**（`sites/*/sources/`、`sites/*/public/**/*.html` 文章正文、`sites/*/public/**/*.md`、`llms*.txt`、`rss.xml`、`feed.json`、`api/*.json` 及 `sites/*/public/assets/images/`）：**[CC BY 4.0](./LICENSE-CONTENT)**（署名共享协议）
