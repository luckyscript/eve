# Native UI redesign implementation plan

**Goal:** Implement the user's Alma-inspired native macOS UI specification directly in the existing SwiftUI client.
**Architecture:** Keep core/bridge unchanged; share semantic light/dark tokens and native components. Present session titles derived from the first projected prompt, distinct user/assistant messages, lightweight evidence disclosures and a floating composer. Existing AppModel actions remain the source of truth.
**Tech Stack:** SwiftUI, AppKit, SwiftPM, existing JSONL bridge.
**Spec:** User's detailed implementation request in this session; direct inline execution, sole writer, no agents.

## Constraints and review focus

- No Electron/WebView, new dependencies, paid requests, or core/bridge edits.
- Preserve tools, skills, capabilities, evolution, configuration, contract, cancel, context and evidence functionality.
- Session metadata must use the existing session API, handle missing/unreadable prompts, reset across workspaces, and filter by title/ID.
- Native keyboard focus, Command-Return submission, multiline Return, accessible controls, minimum 900×640.
- No suite/skill/contract means automatic evolution is unavailable with an explanation; model completion and acceptance stay distinct.
- Test actual welcome/session/settings/catalog rendering at normal/narrow widths and app-only dark appearance; private screenshots remain ignored.

## Tasks

- [ ] Add tested pure presentation logic for prompt titles, Unicode truncation and case/diacritic-insensitive session search. Run targeted Swift tests before implementing the helpers.
- [ ] Implement semantic Theme.swift and sidebar/header/composer/message layout; load title metadata using existing read-only session API. Keep state/actions intact. Build a launchable release bundle early.
- [ ] Unify supporting native pages, add app-only appearance selection, inspect real windows and refine any visible defects. Verify draft entry and navigation without submitting tasks.
- [ ] Document UI changes and exact validation scope; targeted Swift tests and release build, self-review, commit and SSH push main:main.
- [ ] After push run full Node/check/PTY/Swift/release regression, refresh signed bundle and zip, inspect final app, confirm remote SHA and clean worktree. Fix/push/retest any failures.

## Design decisions

A near-white main canvas and ~260pt rounded light sidebar replace the gray dashboard. Session titles are primary; technical IDs move to details/help. Main content is capped at 900pt. User prompts use subdued teal bubbles aligned right; assistant output sits on the canvas. Run/model/acceptance evidence stays in small badges and disclosures. A 96pt editor plus compact action row lives in a rounded floating surface with contract/options popovers. Settings and catalogs retain native forms/tables, with consistent spacing, typography and surfaces. App appearance follows system by default, with explicit light/dark selection for local verification.

This implements the supplied design; no design approval or additional handoff is required by the user.
