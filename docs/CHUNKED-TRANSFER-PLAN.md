# Large-file transfer implementation plan

Planning baseline: BetterSync 0.4.0, 7 November 2026. Implemented at the user's subsequent explicit authorization for the 0.5.0 test prerelease; no database migration. See [implementation evidence and remaining physical-device gate](CHUNKED-TRANSFER-VERIFICATION.md). The iPhone release blocker remains open. The following design records the plan, with current exact wire fields specified in [PROTOCOL.md](PROTOCOL.md).

## Outcome and scope

Keep the product unchanged: files sync, and the normal UI says Synced, Syncing…, Offline, Conflict or Sync error. Retry remains the only recovery action. No chunk settings, modes, device registry, PouchDB, deduplication, content-defined splitting or LiveSync compatibility.

Replace the large-file schema-4 pipeline with one whole-file source read followed by independently encrypted, bounded requests. Preserve the 200 MiB limit, integrity checks, optimistic concurrency, deletion markers, conflict copies and durable recovery. The user's current request authorizes planning internal chunks despite their historical exclusion in SPEC.md; update that contract narrowly when implementing.

The target is **one retained full binary buffer plus bounded working buffers and bounded metadata**, not filesystem streaming or a hard cap on total Obsidian/iOS RSS. Native file reads, crypto, HTTP, copy operations and garbage collection require device measurement. Both directions, recovery and conflict handling are part of the work.

## Proposed fixed protocol

Use schema 5 with domain-separated configuration, document identity, local-state binding and cryptographic purposes. One representation rule based on plaintext size, irrespective of extension:

| Item | Initial implementation choice |
|---|---|
| Small file | Up to and including 64 KiB: authenticated inline content, preserving efficient ordinary-note transfers |
| Large file | Fixed 256 KiB plaintext chunks; last chunk may be shorter |
| Limit | 200 MiB, hence at most 800 chunks; 88 MiB uses 352 |
| File version | Random 256-bit fileVersionId, persisted before the first chunk |
| Chunk identity | Independent random 128-bit ID, persisted before use; opaque, not a content hash |
| Chunk record | Create-only encrypted JSON document, never a CouchDB multipart attachment |
| File record | One authenticated encrypted manifest at a deterministic keyed path identity |
| Publication | Revision-checked manifest PUT only after all chunks are confirmed |
| Automatic remote cleanup | None in this first version |

The 256 KiB choice limits base64/JSON expansion to approximately 342 KiB per full encrypted chunk while avoiding thousands of sequential requests for an 88 MB video. Set a 384 KiB serialized chunk-document limit and a 64 KiB plaintext manifest-metadata limit. At most 800 bounded chunk IDs fit comfortably in the latter; lengths, counts and maximum path size must be included in the exact encoding test. These are implementation constants, not settings. Benchmark them before freezing the schema.

Use separate opaque prefixes for file records and chunk records, for example `f5:` and `c5:`. Prefixes route already-validated record kinds; they never select whether encryption runs. File manifests include encrypted path/kind/deletion/mtime/size/SHA-256, representation, fileVersionId, version salt, chunk size/count and ordered chunk IDs. FileVersionId, ordering and file-to-chunk associations stay inside authenticated encrypted metadata. Public chunk envelopes expose only necessary protocol fields, an opaque ID, nonce and ciphertext. Request timing, document sizes and access patterns remain observable; this is not traffic-analysis protection.

Chunks are immutable by client contract: PUT without `_rev`; never update an existing chunk, never use replication branches or `new_edits=false`. Read by immutable ID and reject a changed generation, missing record or native tombstone. Authentication and the manifest's full-file digest remain necessary: an HTTP success or a first-generation revision is not proof of correct content. File deletion is a normal encrypted file tombstone, not chunk deletion.

## Cryptographic invariant

Only the chunk codec may produce an uploadable encrypted chunk. Its constructor is private to that boundary; the typed transport accepts that result, not arbitrary `Content`. Runtime validation complements types. It must reject plaintext-shaped records, unexpected fields and noncanonical/oversized encodings. Every upload entry point, including retry and recovery, goes through this boundary; no fallback serializer exists.

Use WebCrypto AES-256-GCM with a 128-bit tag and HKDF-SHA-256. Define and test canonical length-prefixed encodings, including canonical integer encodings. Derive a separate chunk key using a fresh per-version salt and domain-separated context. Authenticate at least:

`protocol/schema + purpose + vaultId + fileIdentity + fileVersionId + chunkId + chunkIndex + chunkCount + chunkSize + expectedPlaintextLength`

The manifest has its own key purpose and authenticates the entire ordered list and file metadata. Distinguish manifest, inline content, chunks and configuration in both derivation and AAD. Never reuse the schema-4 AAD literal or silently reinterpret old ciphertext.

Generate a fresh nonce on each actual encryption attempt. Stable version/chunk IDs do not imply reusing a nonce. If a create-only PUT returns 409, fetch the existing chunk, authenticate it in the expected context, and compare its plaintext with the expected source slice before acknowledging it. A different valid encryption of identical plaintext can be accepted; conflicting bytes cannot. A lost reply uses the same reconciliation path. Ciphertext payloads need not be retained in the journal.

Validate count, uniqueness, ordering, exact final-chunk length, total size and SHA-256 before accepting a file. The full hash protects completeness as well as per-chunk authentication. Tests must independently decrypt sample records and attempt cross-vault/file/version/index/ID/count substitution. Existing E2EE does not provide freshness against a malicious server replaying an entire previously valid vault history; this change must not claim to add that property.

## Upload journal and state machine

Extend local state with a body-free outgoing operation: file identity/path, expected base revision, source size and raw/legacy-baseline digests, mtime hint, version ID/salt, ordered chunk IDs, confirmed prefix, phase and failure information. Store the prepared encrypted manifest before its PUT. Dictionary normalization and vault/database binding remain mandatory. Never serialize ArrayBuffers, chunk plaintext, or file-sized ciphertext into plugin data.

State transitions:

`source-check → version-prepared → chunks-uploading → source-recheck → manifest-prepared → manifest-committing → baseline-accepted`

1. Acquire the single large-buffer lease; persist a marker before the source read. Read once and calculate raw SHA-256 plus the existing baseline digest incrementally, yielding to the UI. A source read must not be triggered by file-event handlers.
2. Check the expected remote baseline. Persist the version ID, salt, source digests and all chunk IDs before the first chunk. At 800 IDs the journal is small and bounded. Existing dirty-state/conflict semantics still determine whether an upload is permitted.
3. For each chunk, take a bounded slice/view, encrypt, serialize and send one create-only request. Update the crypto boundary to accept a bounded BufferSource: passing `subarray.buffer` would accidentally pass the entire source file and must be caught by tests. Await its result before allocating the next payload. Confirm returned identity/revision. Save progress at a bounded checkpoint, initially every four confirmed chunks or before yielding/releasing the source. After a crash, at most that checkpoint window needs duplicate reconciliation.
4. Do not rewrite and clone the whole vault state for every crypto/network substage. Keep a coarse durable active-phase marker plus checkpoint; emit detailed, sanitized stages/progress to diagnostics. Cap pending save snapshots. Reuse the existing serial persistence mechanism rather than adding a second database.
5. After all chunks are confirmed, release the original source buffer before rereading the current file. Recheck actual size/hash; mtime is only a hint. If changed, abandon the unpublished version and queue a new one. If absent, do not publish it; retain any required deletion against an existing baseline. Old chunks remain harmless orphans.
6. Persist the exact prepared encrypted manifest and expected revision, then publish it with one revision-checked PUT. This is the remote commit point. On conflict, never retry with a newly fetched revision as permission to overwrite. Release source data before entering conflict preservation.
7. On a lost manifest response, inspect the authenticated current manifest. If it is this exact version/list/size/hash, accept its revision; otherwise use the existing conflict rules. A newer version must not be overwritten. Save the accepted baseline before clearing the outgoing journal.
8. An edit/delete during the final PUT remains queued for the next operation. Startup inventory catches missed events. The accepted baseline always describes the published snapshot, never whatever happens to be local afterward.

On restart, check whether the prepared manifest was already committed before requiring the local source to exist. This is essential when the upload succeeded but its response was lost and the local file was subsequently deleted. If not committed, read and verify the source against the journal before continuing any chunks. Unchanged sources reuse the same IDs; changed sources get a new version. Never mix old and new source slices under one version ID.

## Download and local installation

The current `Remote.readContent(): ArrayBuffer` and buffer-based `compareAndSet` cannot remain the large-binary path. Add an internal staged-content descriptor with authenticated metadata and a private staging handle. Keep the ordinary small-text path and its editor-buffer protections. This is an internal storage representation, not a second sync mode.

1. Authenticate and durably journal the exact file manifest/revision and expected local baseline before filesystem effects. A newer manifest may replace a pending older one through existing receive rules, never by substituting a newer chunk for a missing one.
2. Create a version-scoped staging file beneath the excluded `.trash/bettersync/` area. Fetch one chunk at a time, enforce encoded bounds, authenticate/decrypt, validate its index/length, update incremental hashes and append plaintext. No array of all payloads and no concatenation into a full download ArrayBuffer.
3. Use public `DataAdapter.appendBinary` for assembly. It is documented since Obsidian 1.12.3; raise the minimum version for this implementation and check availability before sync starts. Do not silently fall back to whole-file concatenation. Validate actual iPhone append/copy behavior in the initial capability test.
4. Persist staging offset, confirmed prefix and prefix digest after completed writes. A crash between append and checkpoint can leave extra/partial bytes. If size/digest does not match the checkpoint, discard only this disposable stage and rebuild it. No unsupported truncate/range-write assumption. Never discard recovery files containing user data.
5. Resuming a matching stage requires verifying its contents, not trusting its length. With no public range reader, permit one temporary whole-prefix read to reconstruct hash state and verify the saved digest. Release it before fetching more chunks. No raw hash implementation state is serialized as trusted evidence.
6. Verify final size/hash, including a staged-file readback before installation, with at most one large verification buffer alive. Local comparisons, staging verification and backup verification must have disjoint buffer lifetimes.
7. Journal installation phases; retain the existing captured-original recovery file and non-overwriting destination copy semantics. Preserve divergent local data through a disk-to-disk conflict copy after calculating its digest, rather than holding the old and incoming files simultaneously. Keep mtime behavior and case/type collision checks.
8. Verify the installed target before accepting its baseline. A process kill during copy may leave a partial destination; preserve ambiguous/user-modified bytes and replay from the intact stage/backup. Do not assume a portable copy is an atomic filesystem transaction. Remote publication is atomic; local installation must be recoverable without losing user data. Any stronger filesystem guarantee requires real-device evidence.

Large Markdown uses the same wire representation but must retain `Vault.process` and unsaved-editor protection. Text/editor APIs can retain strings; document their separate allocation budget rather than claiming the binary-buffer bound covers them. No incoming Markdown optimization may remove the editor conflict guard.

## Changes feed and concurrency

Do not run today's `include_docs=true` feed over a database full of inline chunk payloads. Poll `_changes` with `include_docs=false`, retaining a bounded page of IDs/revisions. Classify exact known ID namespaces; unknown/foreign protocol records still stop writes. Well-formed chunk IDs do not become vault paths, incoming file operations or rejected-file payloads.

Fetch file manifests at the revisions reported by the feed using JSON `_bulk_get`, in fixed batches of 16. Validate each response envelope and expected identity/revision. Both inline ciphertext and manifest metadata are bounded; the maximum normal body batch is approximately 2 MiB plus envelope overhead. This avoids an HTTP round trip per ordinary file. Benchmark the additional batched requests against schema 4 before freeze. Do not download chunk bodies just to skip them.

Checkpoint skipped chunk rows normally. Journal valid manifest work or bounded rejection/missing-revision descriptors before advancing the corresponding checkpoint. A page of only chunks must not be mistaken for an empty/end-of-feed page; preserve source-row counts and opaque sequence handling. Chunk creation without a committed manifest must not make an otherwise empty database appear to contain user files during initial setup. Do not use `_all_docs` current revisions as silent replacements for requested historical revisions.

Retain one serial engine. Give a large transfer a quantum of at most four chunks or one second, whichever boundary is reached first, then service queued small files and due remote polling. Continue subsequent quanta immediately when work remains; do not pay the three-second idle poll interval for each quantum. Only one large source may remain resident; a second large file waits or the first is parked with its buffer released. Small-file events remain enqueue-only.

Count actual unresolved native HTTP requests and retained payload bytes, not only the promise-race result. Permit one large-chunk request slot; a timed-out native request keeps that slot until it settles. Reserve bounded capacity for small-file/control requests so a stuck attachment does not consume every slot. Admission happens before reading another large source or allocating its ciphertext. Cap total control requests as well, and retain accounting across reconfiguration. Never grow an unbounded retry queue when native cancellation is unavailable.

These payload bounds cover conforming protocol responses. `requestUrl` can buffer an oversized hostile response before JavaScript validates it; post-read validation cannot enforce a hard native receive-memory cap against a malicious server. Document that limitation separately from authentication guarantees, and do not claim resistance to that resource-exhaustion attack without a transport that enforces a receive limit.

## Recovery and UI

Keep the 0.4 circuit breaker but make its policy explicit by stage. An interruption during whole-file read/hash or local installation pauses that file immediately. A checkpointed small-chunk network interruption may get one durably counted automatic startup retry; a second interrupted recovery pauses it. Clear that startup retry budget on completion or explicit Retry, not merely on every successful chunk. Ordinary completed offline errors use bounded backoff and automatic reconnect recovery. Cleanly paused/backgrounded work at a safe boundary resumes normally.

Persist the next risky-operation marker before attempting it, including on recovery. No missing/failed state save permits work to proceed. A paused file does not block incoming checkpoints or unrelated local operations. Quarantined work keeps Sync error visible; incomplete but progressing work shows Syncing…. Keep a short actionable notice and the existing Retry button. No chunk jargon, version IDs or algorithm choices appear in normal UI.

Diagnostics record direction, sanitized stage, byte count, chunk ordinal/total, confirmed progress, bounded inflight counts/bytes and retry category. Persist only the latest useful checkpoint/phase. Do not log paths, chunk/file IDs, digests, content, credentials, keys or arbitrary exceptions. Instrument the single-buffer lease and allocation boundaries; do not call these measurements an iOS peak-RSS reading.

## Retention and rollout

Do not implement automatic chunk garbage collection in this version. A chunk absent from the latest manifest can still belong to a pending upload, a queued old revision or an indefinitely offline client's recovery. Immediate cleanup after conflict, modification or deletion would be unsafe. The cost is retained remote storage; disclose it. Future GC needs a separate protocol design and cannot assume a device registry or a safe wall-clock expiry.

For the first schema-5 preview, use a fresh dedicated database and the existing explicit setup workflow. Do not automatically migrate, clear, repoint or reuse schema-4 state. Refuse old configurations with an understandable message before writes; old clients must likewise reject schema 5. Reuse recovery-code cryptographic material only if explicitly supported by the new authenticated setup, never by relabeling schema-4 state/configuration. No mixed-schema operating mode. Existing 0.4 users keep their old vault/database intact; any later in-place upgrade is a separately scoped task.

## Implementation sequence and completion evidence

| Step | Main code areas | Required evidence before proceeding |
|---|---|---|
| 1. Capability and format contract | `docs/SPEC.md`, protocol docs, Obsidian adapter spike, allocation instrumentation | Confirm append/copy/recovery on target iPhone and supported Obsidian; exact format/AAD/limits/retry tables; no private APIs |
| 2. Crypto and codecs | `crypto.ts`, `encrypted-protocol.ts`, setup/configuration, new focused chunk codec | Independent decryption vectors; plaintext bypass rejection; substitution/tamper/bounds tests; schema-4 fail-closed tests |
| 3. Durable outgoing transfer | `types.ts`, `local-state.ts`, `encrypted-couch.ts`, `encrypted-remote.ts` | Stable version/IDs, create-only reconciliation, changed/deleted source handling, lost commit response, bounded journal writes |
| 4. Staged incoming transfer | `vault-client.ts`, `conflict-handler.ts`, incoming descriptor contracts | Append/restart/readback/install recovery, conflicting edits, no overlapping old/new full buffers |
| 5. Engine and feed integration | `sync-engine.ts`, `transfer-safety.ts`, `http.ts`, `main.ts` | Fair small-file progress, chunk-only feed pages, bounded unresolved requests, persisted retry limits |
| 6. End-to-end and release gates | Existing encrypted engine/filesystem/wire suites, benchmarks, acceptance docs | Automated and real-CouchDB results, allocation evidence, physical-iPhone repro and all ten device scenarios |

Do not release an upload-only optimization while downloads or conflict handling still assemble multiple full binary buffers. Keep codec and state-machine work in reviewable commits; no automatic publication or version promise is part of this plan.

## Regression and measurement matrix

- Sizes: 0, 1, 64 KiB minus/equal/plus one, 256 KiB minus/equal/plus one, exact chunk multiples, 88,000,000 bytes, 88 MiB, 200 MiB and 200 MiB plus one. Reject oversize before full read where stat permits. Use random-like and compressible synthetic bytes; memory must not depend on compressibility.
- Three independent clients through actual chunk encryption, serialization, CouchDB transport, staged filesystem writes and final size/hash verification. No mocked small-file shortcut. Include existing Markdown/directory/hidden-file/type-replacement behavior.
- Crash before/after journal creation, each chunk PUT/acknowledgement/checkpoint, stage append/checkpoint, source recheck, manifest PUT, baseline save, original-file capture, destination copy and cleanup. Lost responses must not create extra file revisions or divergent chunks.
- Change/delete/rename the source while offline, mid-upload, after server acceptance and before local baseline persistence. Include same-size/same-mtime edits, changes back to previous content and concurrent remote edits/deletes. Assert no mixed-version file and no lost local edit.
- Wrong key/vault/file/version/index/count/chunk ID, missing/duplicate/reordered/truncated chunks, invalid lengths, tampered manifest, wrong final SHA-256, plaintext-shaped upload paths, rewritten chunk generations, malformed local journals and state from another database. No local install or accepted baseline on failure.
- Crash repeatedly on the same file; repeatedly reopen, foreground and reconnect. Assert bounded startup attempts, durable pause, untouched local source, working Retry and progress of unrelated Markdown/attachments.
- Hang native HTTP after JavaScript timeout; verify global slots/bytes remain bounded across many files and reconfiguration. No additional large reads merely because a timer expired.
- Chunk-only changes pages, pagination beyond thousands of records, rejected manifests, interrupted setup and CouchDB compaction. A current file remains downloadable after compaction; a missing queued old manifest remains safely queued/supersedable rather than guessed.
- Assert codec/HTTP payload caps and live source leases directly in production boundaries. Measure 8/32/88/200 MiB runs: incremental payload working memory must remain fixed as file size grows, metadata grows only with bounded chunk count, and journal volume must not grow with file payload. Also measure process RSS and iPhone native memory; explicit allocation accounting alone is not proof of actual peak use.
- Benchmark 1,000 small notes and the 88 MiB transfer at 0/50/100 ms RTT, including journal writes and changes-feed overhead. Confirm small-note network work is batched, and edits made during a large upload are serviced at the next bounded work opportunity.

Run `npm run verify` and `npm run test:integration` against an isolated CouchDB server, never a vault database. Then run the real 88 MB iPhone add/background/kill/restart/retry scenario, verify bytes on desktop and MacBook, and complete all ten tests in `docs/ACCEPTANCE.md`. No release-blocker closure or MVP sign-off until that evidence exists.

## Sources checked for this plan

- Local 0.4.0 code: `encrypted-protocol.ts`, `encrypted-couch.ts`, `encrypted-remote.ts`, `crypto.ts`, `encryption-setup.ts`, `sync-engine.ts`, `transfer-safety.ts`, `vault-client.ts`, `local-state.ts` and the existing regression suites.
- [Public Obsidian API declarations](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts): whole-file reads, binary append since 1.12.3, portable filesystem operations.
- [CouchDB changes API](https://docs.couchdb.org/en/stable/api/database/changes.html): document-free changes pages and opaque checkpoints.
- [CouchDB bulk API](https://docs.couchdb.org/en/stable/api/database/bulk-api.html): explicit-revision JSON `_bulk_get`.
