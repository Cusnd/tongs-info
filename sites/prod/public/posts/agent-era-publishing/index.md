---
title: "后模板时代：为什么个人出版物应该由 Agent 直接书写 HTML"
publication: "Tong's Information"
author: "Tong"
issue: "01"
tier: "essay"
lang: "zh-Hans"
date: "2026-10-28"
updated: "2026-11-24"
concepts: ["agent-web", "static-architecture", "swiss-typography", "bilingual-i18n"]
canonical_html: "https://www.esoren.com/posts/agent-era-publishing/"
canonical_md: "https://www.esoren.com/posts/agent-era-publishing/index.md"
counterpart_md: "https://www.esoren.com/en/posts/agent-era-publishing/index.md"
---

# 后模板时代：为什么个人出版物应该由 Agent 直接书写 HTML

> 传统静态博客框架是为了弥补人类写 HTML 的体力极限而生的妥协。当编写者变成 Agent，我们可以扔掉沉重的构建管线，拿回网页原本的表达自由。

## § 01 模板曾是解放，如今却成了牢笼

过去十五年里，如果你想做一个个人博客，标准答案几乎没有悬念：选一个静态站点生成器（Hugo、Jekyll、Hexo 或 Astro），写 Markdown，挑一套主题，装上一堆插件，再把构建流程交给 CI。

这套范式在「纯手工 Web 时代」无比合理。人类厌倦在五十个 HTML 文件里反复修改同一个导航栏，也不想手拼 `rss.xml` 和 `sitemap.xml`。于是我们发明了模板引擎，用「统一结构」换取「低维护成本」。

但代价同样显而易见：

1. **表达被压扁成一个矩形**：无论你想写的是一则三百字的灵感笔记，还是一篇需要交互式图解与对比实验的深度论文，最终都只能被塞进同一个 Markdown 模子里。
2. **依赖链的慢性腐烂**：两年没更新博客，回来想改一行 CSS，往往要先和过期的主版本框架、Node 版本、打包器插件搏斗半天。
3. **翻译与跨语种传播的高墙**：在传统博客里维护中英双语几乎是一场灾难——繁琐的 i18n 路由配置、僵硬的翻译键、加上人工双语校对的心理负担，让绝大多数个人站最终退回单语。

## § 02 当编辑部里多了一位 Agent

在 Agent 时代，写 HTML、编排 CSS 网格、编写零依赖交互脚本、以及将思想精准转译为另一种语言的边际成本，已经逼近于零。

这意味着我们可以重新提出一个在十年前显得奢侈的问题：**如果每一篇文章都有一位美术指导、一位排印师和一位双语译者随时待命，个人出版物应该长什么样？**

在 *Tong's Information*，我们的回答由三条原则构成：

### 1. 保留纯文本原稿，释放 HTML 的编排权

我依然在 `sources/` 里用最朴素的纯文本和 Markdown 沉淀思考——这是内容的单一事实来源（Source of Truth），确保十年后的任何系统都能无损读取我的文字。

但从 `sources/` 到 `site/` 之间，不再是死板的正则替换，而是 **Agent 的编辑与编排过程**：

- **Tier 1 专栏与随笔（Essay）**：遵循严谨的瑞士网格与排印比例，配备桌面端右侧边注与清晰节号，一分钟内极速成刊。
- **Tier 2 封面特稿（Feature）**：允许破格的版面编排、定制图解、以及直接内嵌在静态 HTML 中的交互实验装置，无需安装任何前端框架。

### 2. 用“秩序层”对抗风格熵增

放任模型毫无约束地每次从零写页面，二十篇之后站点就会变成风格混乱的拼装怪。解决办法不是退回重型框架，而是把**审美秩序显式写成机器可读的宪法**：

- `editorial/DESIGN.md` 定义网格比例、色彩 Token、字号约束与中英混排节奏；
- `AGENTS.md` 固化编辑部发布流程与无障碍底线；
- 极简的零依赖脚本 `tools/editorial_sync.py` 负责所有**确定性机械工作**：同步页眉页脚、派生纯净 `index.md`、生成 `llms.txt` / RSS / JSON Feed / 知识图谱，并在发布前执行死链与结构体检。

**把创造力交给概率模型，把不变式交给确定性脚本。** 这才是 Agent-Native 工程的平衡点。

### 3. 双语不是“翻译插件”，而是默认出版形态

传统网站把 i18n 视作昂贵的工程负担；但在 Agent 时代，当你用母语写完一篇思考，Agent 可以在理解上下文、术语体系和语体气质的基础上，同步打磨出同样自然克制的英文版本，并完成 `hreflang` 互链、双语 RSS 与中英排印微调（例如中文更大的行高与更从容的段间距，英文更紧凑的字距与连字符断行）。

## § 03 纯静态的长期主义

没有 `node_modules` 参与页面渲染，没有数据库需要运维，没有前端框架需要迁移。

浏览器本身就是世界上兼容性最惊人的运行时。一份写得干净的 HTML5 + 现代 CSS（`@layer`、`light-dark()`、原生 `<dialog>`、跨文档 View Transitions）文件，在今天可以跑出满分的加载速度，在十年后依然可以被直接双击打开，被人类优雅阅读，也被下一代 AI Agent 毫无障碍地理解。

这便是 *Tong's Information* 的第一期，也是这座编辑部的起点。
