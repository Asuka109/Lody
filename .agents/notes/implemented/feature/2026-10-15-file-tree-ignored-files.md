# Show ignored files in the Files tree on demand

Status: implemented
Translation: current

[中文](2026-10-15-file-tree-ignored-files.zh.md)

## Abstract

The session Files tree is built from the shared Code Collab file index, which drops
Git-ignored paths while scanning, so `node_modules`, build output and `.env` were
invisible to every viewer. An eye toggle in the Files panel (default: hide, the old
behavior) now overlays those names for the viewer who turns it on, read through a new
per-viewer Machine RPC, `code-collab/list-ignored`, over local IPC or encrypted
Streams. The listing never enters the shared index or owner state, so a name such as
`.env` reaches only that viewer, and search, quick open, `@` mentions and All Changes
are unchanged. The cost is freshness: the overlay refreshes on index revisions,
toggles and re-expansion, not on edits that touch only ignored files.

## Decision

- **CLI.** `CodeCollabV2Service.listIgnored` lists the root with
  `git ls-files --others --ignored --exclude-standard --directory`, where a wholly
  ignored directory collapses into one lazy row, and an ignored directory by its
  direct filesystem children (names only; only `.git` is hidden). No index row vouches
  for these paths, so it checks containment on the real path. It never touches owner
  state, the Flock or watch ownership, caps a response at 5,000 entries
  (`truncated`), and keeps messages path-free because they travel in the clear.
- **Protocol.** `codeCollabIgnoredEntries: 1`. The facade checks it before any I/O, so
  an older daemon fails fast instead of timing out on a dropped request.
- **Renderer.** Hidden sends nothing. Shown, the root listing reloads on mount and per
  provider (index revision); ignored directories load when expanded. The newest
  request per directory wins, and results stay in memory per `viewStateKey`.
  `mergeIgnoredFileTreeEntries` lets indexed paths win, synthesizes missing parents,
  and adopts a directory's listing only after an earlier listing added it as an
  ignored lazy directory, which drops stale listings. Ignored lazy directories load
  through the overlay, never `initializeDirectory`.
- **Control.** A ghost icon `Button` with `aria-pressed`, like the panel header's
  icons, not a `Toggle`: hiding is the default, and a pressed Toggle's ink would make
  the resting state the brightest glyph in the panel. Eye / EyeOff carries the state.

## Alternatives

- **Publish ignored names into the shared index.** Rejected: every member and replica
  would keep names such as `.env` for the Flock's 180-day lifetime, `node_modules`
  would consume the scan budget, and search and mentions would change for everyone.
- **Read the local filesystem in Electron.** Rejected: it only serves the desktop's own
  machine, while the request is cross-device; Machine RPC already routes both.

## Known limits

- Edits that touch only ignored files produce no index revision; the overlay catches
  up on the next revision, a toggle, or re-expanding the directory.
- pnpm's top-level `node_modules` symlinks show as skipped and do not expand.
- Non-Git workspaces show nothing extra. Search, quick open and `@` mentions stay
  index-only. The mobile browser and `AutoFileTreeView` are out of scope.
- A machine without the capability shows "Couldn't load ignored files."

## Verification

Tests cover the CLI listing, both response unions, Streams encryption on client and
server, the facade gate, the merge, and the tree toggle, expansion, cache restore and
re-hide. The remote Streams path is not exercised end to end in the local-only OSS
desktop; only those client and server tests cover it.
