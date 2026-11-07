# BetterSync implementation contract

This is the working implementation contract distilled from the user's **Minimal Obsidian Sync — MVP Specification**, supplied 1 November 2026. That original 30-section specification is the project constitution; this file records the implementation's scope and release gate rather than claiming to reproduce it verbatim.

## Product promise

Three or more independent Obsidian installations synchronize the same vault through one self-hosted CouchDB database. No master, device approval, remote lock or recovery ceremony. Temporary disconnection does not affect local editing. Reconnection and restarts resume automatically. Concurrent edits must preserve both contents without automatic text merging.

## Included

- Regular files, binary attachments, hidden files and explicit directories, including empty ones: create, modify, delete and rename.
- Fixed 200 MiB per-file limit; oversized files remain local and report an error.
- Scope expanded at user request on 2 November 2026.
- Unicode, Norwegian characters, spaces and nested directories.
- Three active clients; additional clients require no new architecture.
- Persistent identity, baseline, checkpoint and interrupted-operation recovery.
- CouchDB connection settings, connection test, enable/disable, manual retry, polling.
- Conservative upload/download confirmation for first setup.
- Normal Markdown conflict copies distributed to other clients.
- High-level status and understandable connection errors.
- Obsidian desktop and mobile APIs, without runtime Node/Electron dependencies.

## Excluded

The active Obsidian configuration folder, `.obsidian`, local recovery trash (`.trash`), settings, plugins, themes, workspace state, P2P, WebRTC, S3, alternate backends, device registries, revision-selection UI, automatic text merging, version-history UI, compression, selective sync, profiles, compatibility modes and LiveSync migration. Internal fixed encrypted chunks were authorized on 7 November 2026 to fix large-file memory use; no chunk settings or second sync model are exposed.

## Safety rules

1. Remote updates must use the revision the client actually based its local file on. Fetching the latest revision is not permission to overwrite it.
2. A changed local file must be preserved before applying divergent remote contents.
3. Remote deletion markers remain available to indefinitely offline clients.
4. Persist an incoming operation before filesystem effects. Advance a checkpoint only after each record is applied or durably retained for retry/diagnosis.
5. One file's error must not stop other files or later changes-feed pages.
6. Replayed operations must be idempotent. Conflict copies must never overwrite existing notes.
7. Never reuse client-local metadata against another server/database.
8. Normal UI vocabulary: Synced, Syncing…, Offline, Conflict, Sync error. Technical details stay in source/logs.

## Initial setup

- Local notes, empty server: ask to upload; cancel is safe.
- Empty local vault, server notes: ask to download; cancel is safe.
- Both populated: refuse ambiguous initialization.
- Both empty: start without a transfer prompt.

## Release gate

All ten scenarios in `ACCEPTANCE.md` must pass on three **real** Obsidian clients, including iPhone. Automated simulations and CI CouchDB tests support that gate; they do not replace it.

## Small implementation decisions

- Hidden paths synchronize through the portable adapter. The active configuration folder, `.obsidian` and local recovery `.trash` remain excluded. Filesystem inventory polls detect changes not indexed by Obsidian.
- Renames are a new-path creation and old-path deletion; there is no identity-independent rename model.
- Conflict names use a short installation ID plus content digest instead of a device name and clock timestamp. This avoids same-minute collisions and duplicate copies after crashes.
- A local deletion against a newer remote edit preserves the remote contents and reports a conflict; no artificial empty conflict note is created.
- Primary-file convergence follows the accepted server version, never wall-clock modification time.
- The installation is bound to its first database. An initialized vault cannot silently switch database in settings.

Apply the anti-cruft rule to future changes: if the software can make a safe decision itself, do not add another setting or mode.

## E2EE work in progress — 4 November 2026

The user authorized E2EE implementation after reviewing `E2EE-PLAN.md`, then the chunked-transfer implementation on 7 November. The development runtime requires schema-5 encrypted setup, using Obsidian SecretStorage and a recovery code. Earlier installations require fresh test vaults/databases; there is no in-place migration or plaintext fallback. Small content stays inline; larger files use immutable authenticated chunks and a manifest committed last, behind the same serial engine. Downloads use the public binary-append API (minimum Obsidian 1.12.3). Schema 5 remains provisional until physical-iPhone verification. The 200 MiB protocol bound is not validated encrypted mobile capacity. Preserve one sync model and the existing real-device acceptance gate.
