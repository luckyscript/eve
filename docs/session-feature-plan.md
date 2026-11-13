# Persistent sessions and independent acceptance — implementation ledger

Spec: the user's implementation brief for base 2255fc81d316076ec651471496999e9912293031. Sole author, native Node ESM, zero dependencies, existing APIs and TUI compatible. Work directly on main as explicitly authorized. Do not change the research proposal. Commit and SSH push before full regression.

Design: `.eve/sessions/ID.json` is the versioned session/task ledger. Atomic replacement with fsync and private modes; per-session process lock serializes writers. Persist model messages, events, tool intent before dispatch and tool result after execution. Recover unfinished runs as interrupted, unresolved intents as unknown; never replay tools. Build protocol-complete continuation history while retaining unmodified raw evidence. Each CLI invocation/TUI prompt creates a run. The independent contract evaluator reads workspace-safe files after the model stops; no executable assertions. Model completion and acceptance are separate fields. Store immutable-per-run contract and skill/tool/model capability snapshots for future readers, without an evolution worker.

## Tasks

- [ ] 1. Tests first: contract artifact rejection, safe paths, session locking/IDs and persistence. Implement `src/contracts.mjs`, `src/sessions.mjs` and durable hooks in `src/agent.mjs`.
- [ ] 2. Integrate `run --session ID --contract FILE`, `sessions`, TUI `/sessions`, `/resume ID`, `/new`; preserve old runAgent behavior. Test separate CLI processes, full multi-tool history, failure continuation, forced interruption and no replay, private evidence and sanitized output.
- [ ] 3. Real configured model: artifact acceptance/rejection and separate-process continuation. Update README and feature verification record. Self-review (no delegated agents per user).
- [ ] 4. Targeted tests/syntax, explicit staging, credential scan that only reports counts; feature commit and SSH push. Only then run `npm test`, `npm run check`, `npm run verify:tui`; fix/push/repeat if necessary. Commit verification record and repeat postpush regression.

Review focus: failed batches must not leave unmatched tool messages; lock recovery must not steal a live lock; symlinked state/contract targets must fail closed; contract values/errors must not leak into CLI; crash evidence must survive without any tool dispatch during load.

Ruling: use whole-ledger atomic snapshots rather than JSONL — bounded PoC history and simpler torn-write protection; cost is O(history) per checkpoint. No exactly-once or mid-tool resumption claim.
Ruling: user's explicit instructions authorize inline work and push on main, and override extra design approval/subagent/worktree gates. Full regression is intentionally deferred until after push.
