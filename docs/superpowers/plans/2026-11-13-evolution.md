# Skill evolution implementation plan

> Execute inline with executing-plans. User explicitly authorized implementation and prohibited agents.

**Goal:** Publish skills only after real independent comparative evaluation.
**Architecture:** Private content-addressed registry, no-tool generator, host-owned JSON suites and isolated session executions. Snapshot publication once per run.
**Tech Stack:** Node >=22, native ESM, zero dependencies.
**Spec:** ../specs/2026-11-13-evolution-design.md

## Global constraints

Single writer; preserve original research; no secret output/global config/force; commit and SSH push before complete regression. Hidden tests never enter generator messages. At most one automatic candidate, no replay. All state private and ignored.

## Review focus

- Symlinks in private state fail closed (registry tests).
- Stale parent or changed evidence cannot publish (CAS/hash tests).
- Missing skill load or timeout is insufficient evidence (evaluation tests).
- Source contracts and hidden strings cannot leak to generation (request capture tests).
- Rollback and concurrent fresh processes observe complete snapshots (process tests).

## Tasks

- [x] Add failing registry/isolation tests; run to confirm failure. Implement src/registry.mjs, publication snapshot in skills.mjs and tool write protections. Check immutable hashes, CAS, missing evidence rejection, rollback and cross-process reads.
- [x] Add failing evolution tests; run to confirm failure. Implement src/evolution.mjs suite validation, bounded generator, source validation, isolated real agent arms, independent verification and publication. Extend contracts with text_equals/sha256_equals. Capture messages to verify hidden exclusion, same budgets and one automatic attempt.
- [x] Add CLI import/capabilities/evolve/promote/rollback and opt-in run automation. Document suite schema and bounds in README; test CLI boundaries.
- [x] Build scripts/verify-evolution.mjs with real source failure, four hidden cases, real candidate generation, fresh-process published run, rollback and refused candidate. Store private report. Run with bounded overall timeout; fix actual defects rather than weaken assertions.
- [ ] Review diff and targeted tests; commit feature, SSH push main:main; then npm test, npm run check, npm run verify:tui, npm run verify:live. Any fixes repeat commit/push/regression. Record SHAs and remote equality.

## Execution ledger

Single feature boundary chosen: registry and evaluator ship together so publication is reviewable with actual acceptance evidence. User authorized main checkout and SSH push; no agents used. Self-review substitutes for a delegated review per explicit user instruction.

Targeted: node --test test/evolution.test.mjs, 16/16 pass (including timeout uncertainty and explicit registry-read rejection). Initial missing implementation and tool-write bypass failures were observed before implementation. Historical body reuse reproduced RED then fixed and GREEN; auto suite replacement reproduced RED then fixed and GREEN.

Real evolution: 55 model requests, four hidden cases. Baseline 1/4, generated candidate 4/4. Fresh process loaded candidate hash and passed contracts; rollback fresh process loaded baseline and failed the correct contract. Unassessed candidate rejected without pointer change. Full private evidence: .eve/runs/evolution-verification.json.

Review decisions: stale registry locks fail closed instead of automatic stealing; host-owned suite is frozen before an automatic source task; historical skill tool bodies expire each run. Feature committed/pushed as 1c1ce77. First post-push full regression: 34/35 passed; protected private skill rejection had changed its error classification text. Existing security assertion retained; corrected missing-skill diagnostic to explicitly mention protected/unpublished paths. Targeted existing security test passed. Fix commit/push precedes a fresh full regression.
