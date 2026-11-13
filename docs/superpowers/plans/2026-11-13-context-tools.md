# Context and workspace tools implementation plan

**Goal:** Deliver the user's third feature on existing native ESM sessions/contracts without changing evolution/registry internals.

**Architecture:** Add bounded literal search and unique exact editing to existing tool dispatcher. Add a derived context service with complete protocol groups, lossless user anchors, expiring historical skill results, source hashes and one optional model summary per run. Raw runs remain immutable evidence. Persist derived compact views separately in session records.

**Constraints:** Node native ESM, zero dependencies; no shell tool; existing path and skill protections. Summary requests count against maxSteps and output-token ceilings. Context budget includes schemas. Required recent groups or user anchors exceeding budget fail explicitly; never truncate tool JSON. Model summarization is inference, not training.

**Review focus:** overlapping edit matches; symlink and protected search roots; oversized recent tool groups; failed summary API; stale skill body surviving compaction.

- [ ] Write failing real filesystem tool tests; implement search_files/edit_file and contract edit readback; targeted tests.
- [ ] Write failing context/mock persistence tests; implement validated configuration, group selection, source provenance, summaries and raw journal separation; targeted tests.
- [ ] Add TUI /tools /status /compact and CLI equivalents; update README and repeatable live script.
- [ ] Review diff locally (no additional agents), targeted validation, feature commit and SSH push main:main.
- [ ] Postpush npm test, npm run check, npm run verify:tui; repair/push/repeat if needed.
- [ ] Live search/edit/readback contract and cross-process compact/recall random fact with 180000–300000 ms per run; ignored sanitized evidence. Report full SHAs and limitations.
