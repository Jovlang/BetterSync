# Schema-4 initial materialization regression

Status: **release-blocking, unresolved on the real Mac**. Do not mark initial-sync acceptance passed from Markdown arrival or a later manual Retry alone.

The reported non-Markdown files were present in the destination's durable incoming journal while the UI remained in Sync error for minutes. Manual Retry subsequently materialized them. This establishes arrival through encrypted record validation and journal persistence; it rules out permanent omission during source scanning/upload for those records. It does not identify the original exception or prove unattended recovery.

Read-only source inspection found 24 ordinary files and one directory, with all 25 entries in saved sync baselines and no pending/rejected source entries. The observed source categories were 18 Markdown files, five small SVGs, one larger JPG and one directory. Those are 25 expected file/directory records, **plus** the separate configuration record (also schema 4). A reported count of 25 schema-4 documents therefore needs clarification: does it exclude configuration? Saved source baselines are not an independent server inventory. The actual server and destination byte comparison remains outstanding.

## Code and synthetic evidence

- The adapter recursively lists files without an extension whitelist. Only documented path exclusions apply.
- The codec selects inline storage by plaintext byte length, independent of extension. Non-Markdown inline bytes and attachment bytes use the same raw-byte materialization path.
- New tests exercise the real ObsidianVault implementation against a synthetic filesystem, rather than MemoryVault alone: Markdown, nested SVG, arbitrary invalid-UTF-8 binary, a 96 KiB synthetic JPG-named binary, nested directories and an empty directory.
- Fresh encrypted upload/download asserts the complete tree, exact file bytes, encrypted feed layout, durable journals and revision-qualified attachment retrieval against isolated real CouchDB.
- Injected copy failures leave ciphertext journal entries, display Sync error and recover on the next normal tick without calling Retry. A separate case reloads the serialized journal and recovers after restart.
- These tests do not reproduce the reported minutes-long Mac stall. They are not real-device acceptance.

## Capture the missing evidence

`scripts/trace-encrypted-tree.js` is a read-only developer-console diagnostic for the running client. It uses the existing authenticated remote, never prints keys, credentials, URLs, note bodies or hashes, and does not mutate files, records or checkpoints. Its output includes paths and sizes; review it before sharing. Run it on the source and destination to compare every supported local entry with authenticated remote bytes. A complete result must have no rejected records and `equivalent: true` on both clients. Account for concurrent edits when comparing snapshots.

If the stall recurs, run it **before Retry**. Preserve the bounded flags for poll scheduling, blocked/stopped engine and running cycle, plus pending journal paths. The diagnostic build additionally logs the failing incoming stage (content-read, local-recovery, local-read, conflict-preservation, local-write or baseline-save), a fixed failure category and optionally a whitelisted filesystem error code. Raw exceptions, paths and payloads are never included in those logs.

No SVG/JPG-specific behavior, transport change or speculative recovery fix has been added. Identify the original failure and verify automatic recovery plus source/destination byte equality before clearing this blocker. Never run the integration-test suite against the acceptance vault database.
