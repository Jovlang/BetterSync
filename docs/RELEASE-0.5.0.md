# BetterSync 0.5.0 — chunked E2EE preview

This prerelease replaces whole-attachment encryption and multipart buffering with independently authenticated chunks and recoverable disk staging. It is a test release, not a claim that the iPhone release blocker or MVP acceptance gate is closed.

## Breaking setup requirement

**Requires Obsidian 1.12.3 or later, a fresh test vault and a fresh dedicated CouchDB database.** Schema 5 cannot join a schema-4 database or reuse its recovery code/local sync state. There is no automatic migration. Preserve your existing vault/database; do not copy old `data.json` into the test installation. Use the same 0.5.0 build on every test client.

## Changes

- Files above 64 KiB use fixed 256 KiB independently encrypted chunks. Stable random version/chunk IDs are journaled before transfer; a revision-checked encrypted manifest publishes the file only after all chunks are confirmed.
- AES-GCM authentication binds each chunk to its vault, file, version, position, count and expected length. Final SHA-256 and size validation remain mandatory. Lost acknowledgements reconcile immutable chunks without duplicate revisions.
- Downloads append to a private disk stage, verify content and recover safely after interruption. Binary replacement, deletion and conflict preservation avoid overlapping whole-file buffers.
- Durable circuit breakers isolate repeated failures and unsafe startup replay. Ordinary offline failures retry with bounded backoff; paused transfers retain local data and pending work until explicit Retry. Unrelated files continue syncing.
- Native HTTP requests remain accounted after timeout. Bounded request slots and cooperative scheduling prevent a stuck attachment from consuming all capacity.
- Add sanitized stage/size/chunk/retry diagnostics and regression coverage for restart, interrupted append/install, changed/deleted sources, malformed state, integrity and small-file progress.

## Validation

- TypeScript, 180 automated tests and the browser build passed.
- Five integration tests passed against isolated CouchDB 3.5 in WSL, including a real 88 MiB three-client encrypted transfer with lost replies, restart, compaction and deletion.
- Actual encrypted/staged benchmarks verified 88 decimal MB, 88 MiB and 200 MiB. Maximum chunk JSON request remained 349,667 bytes. The 200 MiB per-file limit is unchanged.
- Small-note and large-file latency measurements are recorded in the [verification report](https://github.com/Jovlang/BetterSync/blob/0.5.0/docs/CHUNKED-TRANSFER-VERIFICATION.md).

## Remaining limitations and release blockers

The portable Obsidian API still reads one whole source/verification buffer. Native memory, copy/append behavior and UI responsiveness must be measured on physical iPhone. Large Markdown also needs editor/text allocations. The original iOS termination mechanism has not been confirmed by a jetsam/watchdog trace.

The approximately 88 MB iPhone freeze/restart reproduction, the prior intermittent initial-download stall, and all ten desktop/MacBook/iPhone acceptance scenarios remain unaccepted. Automated results do not replace device testing.

Old and abandoned chunks are retained; automatic garbage collection is not implemented. Remote storage may grow after edits/deletions. Do not manually remove chunk records. This preview does not add LiveSync compatibility or an alternate sync mode.

## Install

Download `main.js` and `manifest.json`, or extract the ZIP containing those same two files, into `<fresh-test-vault>/.obsidian/plugins/bettersync/`. Reload Obsidian and use the existing encryption setup flow with a fresh dedicated database. Do not point this build at your existing schema-4 or LiveSync database.

Follow the [physical-device checklist](https://github.com/Jovlang/BetterSync/blob/0.5.0/docs/CHUNKED-TRANSFER-VERIFICATION.md#physical-device-next-step) before considering this build validated for normal use.
