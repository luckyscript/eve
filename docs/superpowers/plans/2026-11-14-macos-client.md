# Native macOS client implementation plan

Goal: deliver dist/Eve.app using SwiftUI and the existing eve core.
Architecture: a fixed Node executable runs a bundled JSONL bridge over pipes; the host owns a pinned workspace, serializes mutations and projects public results. SwiftPM provides the app and separately tested framing protocol.
Spec: user implementation brief in this conversation; existing research documents remain unchanged.

Constraints: no web runtime, HTTP listener, shell dispatch or core rewrite. No credentials in bundle or logs. Request-ID cancellation settles writes before allowing workspace changes. Existing session locks remain. Build artifacts stay ignored. User explicitly authorizes main commits/push over SSH, followed by regression, and prohibits agents.

Review focus: secrets echoed by server; concurrent switch during writes; oversized/malformed pipe frames; interrupted tools; evolution recording failures after publication.

- [x] Bridge: add operation validation/projections, shared auto-evolution preflight, tests for config/session/task/cancel/contracts/skills/registry/evolution and actual JSONL subprocess. Commit/push then regress.
- [x] Native: SwiftPM protocol tests, Process transport, NavigationSplitView chat/timeline/acceptance, native tools/skills/capabilities/settings/evolution, pickers and workspace persistence. Build minimal window first then fill screens.
- [x] Package: fixed bundled Node/bridge/core/resources, Info.plist/ad-hoc signing, release build and tests. Commit/push then regress.
- [ ] Evidence: run same packaged bridge against real model under 30–45 request ceiling, cross-process continuation and compression; launch app and submit native UI task if AX available. Document exact limitations and SHA; final clean remote match.

Execution ledger: direct implementation in user-specified workspace/main; no worktree or agent by explicit user instruction. Tests precede bridge/protocol implementation. UI is verified by compile and smoke rather than implementation-mirroring tests.

Progress: bridge dbf5326, native a32a328, cancellation-race fix 9a46fd2 pushed. Post-push 68 Node tests and 11 PTY checks passed. Swift protocol 3 tests passed. Paid validation used 9 packaged bridge requests + 3 actual native UI task requests. Native file picker automation limitation is recorded in docs/macos-client.md. Author performs review because user explicitly prohibits agents.
