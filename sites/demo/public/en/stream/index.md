---
title: "Stream | Tong's Information - Demo"
publication: "Tong's Information - Demo"
author: "Tong"
section: "stream"
lang: "en"
updated: "2026-11-25"
count: "5"
canonical_html: "https://info-demo.esoren.com/en/stream/"
canonical_md: "https://info-demo.esoren.com/en/stream/index.md"
counterpart_md: "https://info-demo.esoren.com/stream/index.md"
---

# Stream

> Stray thoughts and fragments.

## #005 · 2026-11-25 21:15 · Snippet

Adding `view-transition-class` turns list filtering from an abrupt hide/show snap into archival index cards gliding cleanly along a rail — all in under ten lines of CSS.

```css
html[data-vt-mode="stream-filter"] .stream-item {
  view-transition-class: stream-item;
}
::view-transition-group(.stream-item) {
  animation-duration: var(--duration-moderate);
}
```

*Concepts: Swiss Typography, Interface Craft*

## #004 · 2026-11-22 16:40 · Question

Once `llms.txt` and clean `index.md` twins give AI agents a dedicated high-signal channel, can human-facing HTML finally stop flattening itself into plain text and become a tactile visual medium again?

- *2026-11-24 Update*: This thread grew into Issue 05, complete with an interactive Human/Agent Representation Inspector.

- ↗ Expanded into No. 05: [The Dual-Audience Web: Publishing for Human Eyes and AI Agents](https://info-demo.esoren.com/en/posts/dual-audience-web/)

*Concepts: Agent Web, Edge Architecture*

## #003 · 2026-11-16 11:20 · Quote

> Weniger, aber besser — Less, but better.
> — Dieter Rams

A steady reminder whenever the urge strikes to wrap a control in one more border or slap a status dot on a heading. Restraint isn't scarcity; it lets typography and whitespace carry the room.

- ↗ Expanded into No. 04: [Quiet Interfaces: Designing Beyond the Click](https://info-demo.esoren.com/en/posts/ambient-interfaces/)

*Concepts: Interface Craft, Swiss Typography*

## #002 · 2026-11-08 23:05 · Musing

An idea written in Chinese often lands with aphoristic compression, yet translating it into idiomatic English immediately exposes every unspoken premise. Bilingual publishing isn't just wider reach — it's a built-in calibration mirror for thought.

*Concepts: Agent-Native i18n, Knowledge Graph*

## #001 · 2026-10-30 09:50 · Musing

First studio note on the ledger: no bundler, no runtime framework. Ten years from now, on any machine that can still open a browser, double-clicking these plain HTML and Markdown files should still read cleanly.

*Concepts: Static Architecture, Agent Web*
