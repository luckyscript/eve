# macOS Node host additions

All operations keep the JSONL envelope `{requestID, op, params}`. A failed
operation returns `{requestID,type:"error",error:{code,message}}`; it does not
close stdout or terminate the host. Input is limited to 256 KiB. Every output
frame is strictly smaller than 512 KiB, below native's 2 MiB decoder ceiling.
Oversized legacy results fail with `LIMIT`; subsequent requests still work.

## Configuration

- `workspace {path}` selects the real directory even when configuration is bad.
  It returns `{path,configurationError?}`; the optional error has safe diagnostics.
  Invalid configuration prevents model operations.
- `config.inspect {}` returns `{config,valid,diagnostics,sources}`. `config` is a
  usable projection from defaults plus valid settings, and `apiKey` is only
  `[configured]` or `[not configured]`. A malformed file contributes diagnostics,
  never raw text. Unknown fields are reported without echoing their names/values.
- Priority, from low to high: defaults, `~/.config/eve/config.json`, workspace
  `.eve/config.json`, workspace `.eve/config.local.json`, `EVE_CONFIG`, supported
  environment fields. `sources[key]` identifies the effective value's source;
  invalid fields retain the previous valid/default value and make `valid:false`.
- `configure {values}` and `secret {value}` remain available. Configuration is
  checked after admitting the settings operation, so ordinary load failures do
  not block settings recovery. Keys must use the dedicated secret operation.
- `config.repair {values,confirm:true}` repairs `.eve/config.local.json`. It
  validates the complete proposed configuration, preserves all parsed fields
  and credentials, and rejects unknown/unrepaired invalid fields. For invalid
  JSON or a non-object document, the confirmed values replace the broken
  document. Before publishing the replacement, exact original bytes are synced
  to a new mode-0600 backup in `.eve/evolution/config-backups/`, under mode-0700
  directories. An ending workspace ignore rule protects this backup directory.
  The local configuration is also ignored and must not already be Git tracked.
  Symlink configuration/ignore/private directories are rejected. Invalid global,
  shared or externally selected configuration and invalid environment values
  require fixing their source; repair will not overwrite or silently shadow them.
- Public configuration/model IDs are explicit metadata projections. They remain
  visible even if an API key happens to be a substring. Prompts, final answers,
  history and transient answer text continue to redact credential occurrences.
- `connection.test {}` makes only `GET <baseUrl>/models`, with a 10-second total
  deadline and 256-KiB response-body limit. No generation request is issued.
  Returns `{ok,models:[{id}],error?,latencyMs}`. Missing model endpoints return an
  explicit HTTP error/status; headers, provider error bodies and keys are hidden.

Error categories include `HTTP401`, `HTTP`, `TIMEOUT`, `CANCELLED`, `LOCK`,
`BUDGET`, `CONFIG`, `VALIDATION`, `PROTOCOL`, and `LIMIT`, plus the remote adapter's
safe `REMOTE_*` errors. Core non-streaming HTTP errors retain their original
`HTTP` code for existing CLI/core consumers; the host projects HTTP 401 explicitly.

## Sessions

- `sessions {query?,includeArchived?}` still returns an array of summaries with
  `id,title,archived,runs,status,updatedAt`. `runs` is a count, never the run bodies.
  Default title is the first prompt's first 160 characters, or the session ID.
  Archived sessions are excluded unless requested. Unavailable/locked ledgers
  retain an unavailable summary rather than silently disappearing.
- Enumeration covers the first 1,000 valid ledger filenames in lexicographic
  order. Search is a case-insensitive literal substring match over custom title,
  every run's prompt and each message's string `content` (including assistant and
  tool content), in chronological order. Each ledger has a 4,194,304 UTF-16-code-
  unit search-text ceiling. It does not search raw responses, event metadata,
  tool argument fields, or non-string content. It returns summaries only. These
  limits are deliberate; this is not an unlimited filesystem full-text index.
- `session.page {sessionId,cursor?,limit?}` returns
  `{id,runs,nextCursor,hasMore,total,truncated?}`. `limit` defaults to 20, range
  1–100. **Without cursor it returns the latest page.** Runs within each page are
  oldest-to-newest. `cursor` is an opaque decimal exclusive end index returned
  as `nextCursor`; pass it to fetch the immediately older page, then prepend
  that page's runs. `nextCursor:null` means there are no older runs. Concurrent
  append-only runs do not shift older indices.
- Page size is also bounded by serialized UTF-8 bytes; it may contain fewer than
  `limit` runs. A single oversized run becomes an explicit `truncated:true`
  placeholder preserving identity/status and a readable `LIMIT` error. The page
  also reports `truncated:true`. Raw ledger evidence remains intact. Pagination
  always advances past an oversized run; it does not drop or corrupt JSON.
- `session {sessionId}` remains available, but an oversized result returns `LIMIT`
  with a paging suggestion instead of killing the protocol.
- `session.rename {sessionId,title}` accepts nonempty titles up to 160 characters.
- `session.archive {sessionId,archived:Boolean}` preserves ledger and artifacts.
- `session.delete {sessionId,confirm:true}` deletes only the validated session's
  `.json` ledger, holding its writer lock through unlink and directory sync. An
  active writer lock cannot be stolen. It returns `writesReverted:false`; files,
  experiments and generated artifacts are never rolled back.

## Streaming and remote lifecycle

`run` accepts `stream:Boolean` (default false, including CLI). True requests SSE,
with JSON response fallback for older compatible providers. The host sends only
`{type:"assistant_delta",text,step}` answer-content events, never reasoning or
partial tool arguments. UTF-8 decoding survives network byte splits. Tool call
IDs/names/arguments are assembled before normal protocol validation and execution.
Missing completion, malformed streams, cancellation and output truncation prevent
partial tools from executing. Stream input has a 2-MiB total ceiling and 20,000
SSE data-event ceiling. UI text is split into bounded Unicode-safe frames.

A suffix-buffer redactor withholds possible credential prefixes across provider
chunks, emits complete matches as `[redacted]`, flushes legitimate suffixes on
normal completion, and discards held suffixes on interruption. Transient deltas
bypass the durable checkpoint/event ledger, avoiding token-by-token fsync. Raw
final model responses, tool intents/results and existing checkpoints retain their
original durability and security behavior.

The host instantiates C lane's `createRemoteOperations({getWorkspace,isLocalBusy})`,
merges `remoteFields`, and routes `remote.*` to that adapter before local argument
validation/reservation. Local run/compact/evolve refuse admission while remote is
busy; the adapter sees local reservations. Workspace switch awaits
`beforeWorkspaceSwitch()` before changing the root. EOF aborts local requests,
awaits settlement and `host.shutdown()`. Remote status uses C lane's explicit
projection; invitation credentials are returned only by `remote.invite`.

Local-only verification: `npm run test:macos-host`, `npm test`, `npm run check`.
The host UX test uses mocks, actual loopback HTTP/SSE fixtures, and actual Node
JSONL subprocesses; it never calls a paid model.
