---
title: "思维 | Tong's Information - Demo"
publication: "Tong's Information - Demo"
author: "Tong"
section: "stream"
lang: "zh-Hans"
updated: "2026-11-25"
count: "5"
canonical_html: "https://info-demo.esoren.com/stream/"
canonical_md: "https://info-demo.esoren.com/stream/index.md"
counterpart_md: "https://info-demo.esoren.com/en/stream/index.md"
---

# 思维

> 碎片思考与碎碎念。

## #005 · 2026-11-25 21:15 · 切片

给碎片流加上 `view-transition-class` 之后，筛选分类不再是生硬的显隐跳变，而是像活页纸片顺着导轨滑入新位置——核心 CSS 不到十行。

```css
html[data-vt-mode="stream-filter"] .stream-item {
  view-transition-class: stream-item;
}
::view-transition-group(.stream-item) {
  animation-duration: var(--duration-moderate);
}
```

*关联概念: 瑞士排印与网格, 界面克制与意图设计*

## #004 · 2026-11-22 16:40 · 待解

既然 `llms.txt` 和 `index.md` 已经替 AI Agent 铺好了极致纯净的高信噪比管道，那人类访问的 HTML 网页是不是终于可以卸下“信息喂食槽”的包袱，重新做回一件值得凝视的视觉作品？

- *2026-11-24 追记*: 这个念头最终长成了 No. 05 封面特稿，顺手还做了一套双面透视实验室。

- ↗ 已展开为 No. 05: [双面万维网：同时写给人类眼睛与 AI Agent 的出版架构](https://info-demo.esoren.com/posts/dual-audience-web/)

*关联概念: Agent 万维网, 边缘演进架构*

## #003 · 2026-11-16 11:20 · 摘录

> Weniger, aber besser — 少，却更好。
> — Dieter Rams

每次忍不住想给按钮外再套一层边框或加个状态红点时，就把这句话贴在眼前。克制不是贫瘠，而是让真正重要的文字与留白自己说话。

- ↗ 已展开为 No. 04: [宁静界面：当交互从点击转向意图](https://info-demo.esoren.com/posts/ambient-interfaces/)

*关联概念: 界面克制与意图设计, 瑞士排印与网格*

## #002 · 2026-11-08 23:05 · 随想

同一个想法，用中文写出来往往凝练如金句，转成英文时却会立刻暴露隐含的前提和逻辑跳步。双语出版不只是多照顾一拨读者，更像自带一面逻辑校准镜。

*关联概念: Agent 原生双语, 思想图谱*

## #001 · 2026-10-30 09:50 · 随想

开卷第一条手记：不装任何构建器，不依赖运行时框架。十年后随便找一台还能打开浏览器的设备，双击这几个纯文本与 HTML 文件，它们应该依然读得清清楚楚。

*关联概念: 纯静态架构, Agent 万维网*
