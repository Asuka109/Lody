# Remote ranged file download

Status: implemented
Translation: current

[中文](2026-10-15-remote-ranged-file-download.zh.md)

## Abstract

A remote viewer had no way to get a session file that the remote preview refused
as too large: the "File is too large to preview" card offered only Copy file path,
and the menu download read through the same single bounded preview response, so
it always failed for exactly those files. A new `file/read-range` Machine RPC
method, negotiated through the `fileReadRange` capability, now serves one range of
at most 4 MiB per request under the remote preview's authorization. The client
reassembles files of up to 256 MiB, pinned to one file revision. The card, the
file menus and the assistant Markdown file-link menu offer Download file with
progress and cancellation. Machines without the capability keep the old bounded
download in the file menus only. Both budgets reuse the proven preview response
size; nobody has measured them against the hosted gateway yet.

## Problem and evidence

File Preview v3 answers in one response bounded by `FILE_PREVIEW_V3_LIMITS`
(10 MiB text, 5 MiB binary, 1 MiB gzip) and refuses rather than truncates a larger
remote file. The remote download in `use-session-file-actions.ts` read through that
same `openFile` call, and its own comment recorded the ceiling: it reported
`sessions.fileActions.downloadTooLarge` for every file the error card was shown
for. A Download button added to that card would therefore always fail. The
[file surfaces guide](../../../docs/sessions-file-surfaces.md) already stated that
lifting the ceiling needed a ranged Machine RPC method behind a protocol
capability, not a client-side retry.

## Decision

- **Protocol.** `file/read-range` lives beside `file/preview`, outside
  `code-collab/`, in the same owner-session encrypted envelope with the same owner
  verification (`isOwnerScopedEncryptedRpcMethod`). A request names
  `offset`, `length` and, after the first range, `revision`. The schemas and
  budgets are in `packages/shared/src/file-read-range.ts`. The capability version
  is the wire version, so the advertiser and the checker cannot drift.
- **Machine.** `FilePreviewService.readFileRange` resolves and authorizes every
  range like a remote preview (same workspace resolver, same path policy, never
  the local arbitrary-path mode), so a range cannot outlive a revoked path. The
  revision is a hash of device, inode, size and nanosecond mtime. A mismatch before
  or after the read, or a short read, answers `file_changed`. The service never
  returns partial or mixed bytes and never activates Code Collab.
- **Client.** The facade sends the method only to a cloud-plane machine
  advertising the capability, so a same-machine Electron path never reaches the
  Streams plane. `lib/session-file-range-download.ts` keeps one range in flight
  and rejects any range whose revision, offset or size disagrees. It also rejects
  empty ranges before the end, which would otherwise loop forever. The hook shows
  a progress toast with Cancel and saves only a complete file. Download appears
  on the error and notice card and in the Markdown-link menu only through this
  transport, because the preview-read fallback would fail for those files. Native
  mobile keeps its bounded share export.
- **Copy.** On the card, Download file leads as the raised `secondary` action and
  Copy file path recedes to `ghost`, the same hierarchy as the local-host Open and
  native Share actions. The Markdown-link menu now uses the same "Copy file path" string as the
  card; the separate `sessions.fileActions.copyPath` ("Copy Path") key is removed.
  This extends the remote "Copy Path only" menu from the
  [Markdown file-link menu decision](2026-09-17-markdown-file-link-context-menu.md)
  without changing its local/remote capability scoping.

## Alternatives considered

- **Only add the button over the existing download.** Rejected: it always fails
  for the files the card is shown for.
- **Raise the preview budgets.** Rejected: one Machine RPC response has a gateway
  ceiling that this repository does not assert, and the server does not retry a
  non-404 4xx append failure.
- **Machine-pushed progress envelopes on one request**, like
  `machine/acp-binary-progress`. Not chosen: pulled ranges keep each request one
  bounded response, keep the machine stateless between ranges, and make
  cancellation a matter of not asking again.
- **Parallel ranges.** Deferred: each range occupies one of the machine's bounded
  RPC slots, and sequential transfer is enough for the 256 MiB ceiling.

## Limits

- The client holds the whole file in memory (Blob parts) until it saves it, which
  is why the 256 MiB ceiling exists on both ends.
- A failed range fails the whole download; there is no per-range retry.
- The 4 MiB and 256 MiB budgets are inherited from the proven 5 MiB binary preview
  response, not measured against the hosted Streams gateway. The
  [Spec](../../../../specs/local-file-link-actions.md) lists this as an open question.
- Machines must update their CLI before the card or Markdown menu offers Download.

## Verification

Executed with installed workspace dependencies: CLI service tests (range
reassembly and clamping, `file_changed`, `too_large`, `path_not_allowed`, empty
file and `invalid_range`); Machine RPC server tests (encrypted envelope and
owner-mismatch rejection); the shared capability test; and component tests for the
hook (ranged download, revision failure, cancellation, Electron local guard and
menu contents), the chunk assembler, the facade guard and the notice-card button.
Typechecks pass for `@lody/shared`, `@lody/loro-streams-rpc`, the CLI and
`@lody/components`. No one has run an end-to-end transfer against a real machine
and the hosted gateway, or tried the UI by hand.
