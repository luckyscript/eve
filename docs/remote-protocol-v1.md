# Eve Remote v1 — implementation contract

Status: implementation contract for the Eve Android client and Eve computer connector. This document does not describe Alma's private E2E or business protocol. Eve reuses Alma Relay protocol 1 only as an opaque transport. All credentials and addresses below are schematic, not actual pairing values.

## Transport and pairing

The computer connects outbound to `/agent?th=H`, where H is lowercase hex SHA-256 of the routing token, and registers `{t:"register",tokenHash:H,proto:1,key?:registrationCredential}`. Android opens a normal WebSocket at `/c/ROUTING_TOKEN/__eve_remote__`. The computer handles the relay's `wopen`, `wopened`, `wmsg`, `wclose` protocol-1 envelopes. Reject other tunneled paths and all HTTP requests. Do not log URLs containing routing tokens. Production connections require HTTPS/WSS. Explicit development mode may permit loopback HTTP/WS only.

An invite is displayed locally as `eve://pair?data=BASE64URL_UTF8_JSON` (or pasted into Android). JSON fields:

```json
{"v":1,"relayUrl":"https://relay.example","routingToken":"RANDOM_BASE64URL","pairId":"UUID","secret":"BASE64URL_32_RANDOM_BYTES","expiresAt":1893456000000,"desktopName":"My Eve"}
```

The payload is a credential: display only in a deliberate local pairing UI, never logs, Git, screenshots or test reports. Desktop stores it privately under `.eve/remote/` with 0600 files. First successful authenticated connection consumes the invite and binds it to Android's random persisted `clientId`. Further clients are rejected; a bound client may reconnect after the invitation expiry. Revoking the pair invalidates future connections and disconnects current ones. Android stores the credential encrypted using Android Keystore. Connector enablement and invite creation require local action; remote clients cannot create invites or expand permissions.

## Mutual authentication

All random nonces are 32 bytes encoded unpadded base64url. Secret is exactly 32 decoded bytes. IDs and names have bounded validated lengths. Messages have a handshake timeout.

1. Client sends `{v:1,type:"hello",pairId,clientId,clientName,clientNonce}`.
2. Server sends `{v:1,type:"challenge",serverNonce,proof}`.
3. Client verifies proof and sends `{v:1,type:"authenticate",proof}`.
4. Server verifies, atomically binds/validates client, and sends the first encrypted payload `{kind:"ready",clientId,desktopName,protocol:1}`. Client must wait for ready before application requests.

For direction `server` or `client`, proof is unpadded base64url HMAC-SHA256(secret, UTF-8 of the following exact string, without a trailing newline):

```text
eve-relay-v1\nDIRECTION\nPAIR_ID\nCLIENT_ID\nCLIENT_NONCE\nSERVER_NONCE
```

In the block above `\n` denotes a newline byte. Compare MACs using constant-time comparison on the computer. Binding occurs only after successful client proof. An invite is not consumed merely by opening a socket.

## Encryption and replay protection

HKDF-SHA256 input key material is the decoded 32-byte secret. Salt is `clientNonceBytes || serverNonceBytes`. Output length is 32 bytes. Derive two keys with UTF-8 info `eve-relay-v1:c2s` and `eve-relay-v1:s2c` respectively. No extra context or terminator is added.

Application messages are:

```json
{"v":1,"type":"encrypted","seq":1,"data":"BASE64URL_CIPHERTEXT_PLUS_16_BYTE_TAG"}
```

AES-256-GCM, nonce = four zero bytes followed by seq as unsigned 64-bit big-endian. Sequence starts at 1 separately per direction and must be exactly previous+1; reject replay, gaps and invalid tags, then close. AAD = UTF-8 `eve-relay-v1\nDIRECTION\nSEQ`, where DIRECTION is `c2s` or `s2c`, SEQ is unsigned decimal. Fresh client/server nonces and fresh derived keys are mandatory on every reconnect. Maximum seq is 2147483647; reconnect before exhaustion. Limit encrypted frames to 512 KiB and request plaintext to 64 KiB. Invalid/oversized frames fail closed without echoing secret input.

This PSK protocol authenticates possession of the out-of-band pairing credential and hides application contents from the relay. It does **not** provide forward secrecy, official Alma E2E interoperability or protection from a compromised endpoint. Relay routing metadata remains visible. TLS is still required outside explicit loopback development mode.

## Encrypted application protocol

Client payload: `{kind:"request",id:"UUID",op:"OPERATION",params:{...}}`.

Server payloads:

- `{kind:"response",id,ok:true,result:{...}}`
- `{kind:"response",id,ok:false,error:{code,message}}`
- `{kind:"event",requestId,event:{...}}`

Required operations (exact names):

| op | params | result outline |
|---|---|---|
| `desktop.info` | `{}` | `{name,workspace,protocol,permissions,busy}` |
| `sessions.list` | `{}` | `{sessions:[{id,title,status,updatedAt,runCount}]}` |
| `sessions.get` | `{sessionId}` | `{id,runs:[{id,prompt,final,status,modelStatus,verification,stats}],truncated}` |
| `run.start` | `{sessionId?,prompt,contractName?}` | `{sessionId,runId,status,modelStatus,verification,final,stats}` |
| `run.cancel` | `{requestId}` | `{requested:boolean}` |
| `run.lookup` | `{requestId}` | `{state:"unknown|running|completed|failed",result?,error?}` |
| `skills.list` | `{}` | `{skills:[{name,description,hash}],warnings}` |
| `capabilities.list` | `{}` | projected registry state, no private bodies |
| `context.status` | `{sessionId}` | existing projected context status |
| `context.compact` | `{sessionId}` | projected compaction result |

Contract names are optional names from a locally configured allowlist, not arbitrary remote paths. The workspace is fixed by the local computer connector; remote calls cannot select arbitrary directories. Additional operations require explicit documentation and tests. Do not expose config secrets, generic filesystem access, arbitrary core module invocation, shell, invite administration or arbitrary evolution publication over remote API.

For run.start, before invoking model/tools, atomically persist requestId + canonical params hash + pairId + operation status in the private desktop ledger. Repeated requestId with same pair and params returns/looks up the existing operation and must not execute twice; a conflicting request is rejected. After a crash an unresolved operation is `unknown/interrupted`, never automatically replayed. Reconnect clients refresh sessions and use run.lookup; transport loss must not imply task failure or retry the task under a fresh ID. Requests and cancellation are scoped to the authenticated pair. Desktop connector serializes mutating operations and uses existing core session/verification semantics.

Events are redacted projections: model step, tool name, status, skill hash, context summary metadata, usage and acceptance — not full arguments, tool results, configuration, model prompts or hidden suites. Final messages and user-facing conversation text are bounded. Oversized responses return a clear limit/truncation marker; never silently truncate JSON frames. Attachments, FCM push, background-service reliability and remote evolution administration are not part of v1.

## Required verification

Cross-language golden vectors for HKDF/HMAC/AES, wrong secret/replay/tag failures, invite expiry/binding/revocation, request deduplication and interrupted-no-replay. Integration must use the real pinned Alma Relay server or clearly distinguish a protocol stub from compatibility evidence. Android must compile to an APK; device/emulator UI claims require actual installation and observation. Real-model validation must flow through relay and encrypted application protocol to Eve's existing task/session core, with independent output verification.
