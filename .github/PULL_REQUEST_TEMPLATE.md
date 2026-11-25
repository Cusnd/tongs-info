## Summary

- What changed and why?

## Affected Scope

- [ ] Shared engine (`engine/`, `editorial/`, `tools/`)
- [ ] Demo site (`sites/demo/`)
- [ ] Production site (`sites/prod/`)
- [ ] CI/CD or documentation (`.github/`, `README*.md`, `AGENTS.md`)

## Verification

- [ ] `python tools/editorial_sync.py --all --check --stage` passed with 0 errors
- [ ] `python tools/smoke_test.py --site demo --local --dist .dist/demo` passed
- [ ] `python tools/smoke_test.py --site prod --local --dist .dist/prod` passed
- [ ] Checked light & dark modes and ZH ↔ EN switching (for UI/content changes)
