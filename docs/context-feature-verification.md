# Context and workspace tools verification

Implemented on baseline `d8f7f45`, without edits to evolution/registry or the prior technical proposal. No extra agents were dispatched.

- Feature: `80f31fc681a2b7212e6699f7f4208bd055f09f4c`
- Real-model summary boundary fix: `06037adb5f92b8e8a05ee567e96c9e976e066bd3`

The feature was committed and pushed over SSH before full regression. Postpush regression found 50/50 tests passing, syntax checks passing, and all 11 PTY checks passing. The first real-model run accepted search/edit/readback but failed the unchanged fact-in-summary assertion: the summarizer obeyed a historical reply-only instruction. The fix quotes the complete selected history as data under one explicit current summary task, records the request hash and selected model sources, and adds a regression test. It was pushed before repeating full regression: 51/51 tests, syntax checks, 11/11 PTY checks.

## Real model evidence

`npm run verify:agent` passed on 2026-11-13 after the fix. Each task uses a 240000 ms deadline, at most eight model requests (including at most one summary attempt), twelve tools, and a requested 1024 output tokens per call. Private original ledgers remain under the ignored verification workspace; sanitized reports are in ignored `.eve/runs/agent-verification.json` and `.eve/runs/agent-verification-first-failure.json`.

| Task | Requests | Tools | Summary attempts | Elapsed ms | Acceptance |
|---|---:|---:|---:|---:|---|
| Literal search → unique edit → readback | 4 | 3 | 0 | 20377 | passed |
| Read and remember random file fact | 2 | 1 | 0 | 7580 | not requested |
| Read large trace | 2 | 1 | 0 | 7494 | not requested |
| Read recent small tool result | 2 | 1 | 0 | 6558 | not requested |
| Separate-process compression | 1 | 0 | 1 | 30707 | raw evidence and summary assertions passed |
| Another-process recall → write → readback | 3 | 2 | 0 | 16728 | passed |

The uncompressed historical messages occupied 18190 serialized characters; the complete request before compression was 21654 characters including system/schema. The next budget was 12000, and compression reduced the complete context to 6184 characters. Eight source messages were summarized, with source digest `90a3ee50ba1d7c3422e95cfc1cb71bdbbe31f02787e32644f3b2e9b3a3142b34`.

The random fact was read from a file and absent from all user prompts, retained recent messages, and contract system metadata. The file was deleted before compression/recall. The model summary had to include it, and a separate process then had to write its exact value and pass independent JSON/readback assertions. Existing runs were hash-compared before and after manual compaction and remained unchanged. Small tasks made zero summary requests. No assertions were relaxed after the first failure.

## Limits

This is local evidence for these tasks, not general lossless long-context reasoning. Summary input selection can omit oversized old groups; deterministic fallback retains exact user originals and sourced tool trajectory, not every fact from file results. User originals, the latest complete tool group, current task/system and active skill loads must fit the configured budget or the run fails explicitly. Skill hash changes discard the prior model summary conservatively, potentially losing unrelated summarized facts. Raw evidence is retained.

The character budget is serialized JSON length, not a tokenizer estimate. Request count, request parameters, local character limits and wall-clock are enforced by eve; actual token accounting depends on the provider. In this run the summary response reported 1510 completion tokens despite a requested 1024, so this provider's usage cannot be claimed as a hard actual-spend ceiling. Across all six tasks it reported 33345 prompt tokens and 2597 completion tokens.

Path checks preserve the existing trusted-local-workspace boundary and TOCTOU limitation. No shell, arbitrary exec, dependency installation, or arbitrary network tool was added. This feature does not train the model.
