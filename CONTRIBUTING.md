# Contributing to Tong's Information

Thank you for your interest in contributing to **Tong's Information**!

## Core Principles

Before opening a Pull Request, please review:

- [`AGENTS.md`](./AGENTS.md) — Architecture, shared-engine rules, and publishing invariants
- [`editorial/DESIGN.md`](./editorial/DESIGN.md) — Swiss modernist visual grammar and anti-decoration rules
- [`editorial/MOTION.md`](./editorial/MOTION.md) — Five-layer zero-discontinuity motion grammar

Key guardrails:

1. **Zero Runtime Dependencies**: Never add third-party JS frameworks, CSS frameworks, or bundlers to `engine/` or `sites/`.
2. **Site-Agnostic Engine**: Keep `engine/` and `editorial/partials/` completely free of hardcoded site names, authors, or domains. All site-specific values come from `sites/<site>/catalog.json`.
3. **Accessibility & No-JS Resilience**: Preserve one main `<h1>` per page, visible `:focus-visible` outlines, reduced-motion discipline, and full readability with JavaScript disabled.

## Local Verification Checklist

Every PR must pass the full deterministic audit and local HTTP smoke suite for both `demo` and `prod`:

```bash
python tools/editorial_sync.py --all --check --stage
python tools/smoke_test.py --site demo --local --dist .dist/demo
python tools/smoke_test.py --site prod --local --dist .dist/prod
```

If you changed shared partials (`editorial/partials/`), `catalog.json`, or source manuscripts, run:

```bash
python tools/editorial_sync.py --all
```

and commit the resulting synchronized artifacts.

## Licensing

By contributing code, engine assets, tools, or documentation, you agree that your contributions will be licensed under the **MIT License** ([`LICENSE`](./LICENSE)). Any editorial prose or artwork contributions are licensed under **CC BY 4.0** ([`LICENSE-CONTENT`](./LICENSE-CONTENT)).
