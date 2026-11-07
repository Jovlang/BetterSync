# Schema 5 protocol and recovery

0.5.0 test prerelease. One encrypted sync model, fresh dedicated database, no migration or mixed-schema mode. Obsidian 1.12.3+ and public DataAdapter.appendBinary are required. Earlier formats are historical in [PROTOCOL-SCHEMA4.md](PROTOCOL-SCHEMA4.md). Physical-device acceptance remains open.

## Records and cryptographic binding

Configuration, recovery codes (bse5), path identities (f5:), local-state binding and cryptographic domain (bettersync-e2ee-5) distinguish this format from schema 4. Authenticate configuration before file writes. HTTPS credentials and the independently held recovery key have separate roles.

Files have deterministic keyed path identities. Each live file version has a fresh random 256-bit version ID and 256-bit HKDF salt. The manifest envelope exposes _id, optional _rev, schema/protocol/vault, salt, metadata nonce and encrypted metadata, plus inline ciphertext for small files. Encrypted metadata contains path, kind, deletion flag, mtime, exact size, raw SHA-256, version ID, ordered chunk IDs and inline nonce. Representation follows authenticated size: live files <=65,536 bytes are inline; larger files use chunks. Directories/deletion markers have no content/version/chunks.

Chunks contain at most 262,144 plaintext bytes, at most 800 chunks for the unchanged 209,715,200-byte file limit. The final chunk has exactly the remaining length. Chunk IDs are independent random 128-bit values prefixed c5:. Chunk envelopes contain only _id, optional _rev, schema/protocol, nonce and ciphertext. There is no content-hash naming or deduplication. Maximum encoded chunk document: 384 KiB; plaintext metadata: 64 KiB. Reject extra fields, noncanonical base64url, duplicate IDs, incorrect counts/lengths and unsafe paths.

WebCrypto AES-256-GCM uses 128-bit tags and fresh 96-bit nonces on every encryption attempt. HKDF-SHA-256 derives purpose-specific keys. Canonical framing is UTF-8 fields with four-byte big-endian byte lengths. For chunk key derivation, fields are:

`domain, vaultId, fileIdentity, "chunk", versionId, chunkId, decimalIndex, decimalCount, "262144", decimalExpectedLength`

The HKDF salt is the version salt. Chunk AAD is:

`domain, "5", vaultId, fileIdentity, salt, "chunk", versionId, chunkId, decimalIndex, decimalCount, "262144", decimalExpectedLength`

Metadata, inline content and configuration use distinct purposes; inline content also binds version ID. Only the codec private constructor/runtime WeakSet can issue uploadable chunks. Prefixes never select whether encryption runs. Chunks are create-only PUTs without _rev; reads reject revision generations other than 1. On 409, decrypt the existing record in the expected context and compare its plaintext with the source slice. Lost acknowledgements cannot create duplicate chunk revisions; retries encrypt with fresh nonces even with stable IDs. The encrypted manifest binds the entire list, size and SHA-256.

## Upload and publication

Events enqueue paths; one serial engine reads files. Persist a marker before the source read. Incremental hashing yields, but Obsidian still returns one whole source buffer. Journal source digests, base revision, version/salt, chunk IDs and confirmed prefix before the first upload. Never journal source bytes or chunk ciphertext. Encrypt bounded views, never their whole backing buffer.

Send one chunk at a time; checkpoint after four chunks or one second, then service eligible small work in the same serial loop. A small edit discovering a large remote conflict queues that manifest instead of nesting another large read. After the last chunk, release the source before rereading/hash-checking the live file. A changed source gets a new version/IDs; an absent unpublished source is not published.

Persist the exact encrypted manifest, then PUT with the original baseline revision. This is the remote atomic commit point. No manifest exposes a partial upload. Revision conflict never authorizes overwriting a newer version. On lost reply/restart, reconcile the prepared manifest against authenticated server state before requiring the source to exist. The changes-feed receive path also reconciles, including after local deletion. Persist the accepted snapshot baseline and clear its journal together; dirty events/inventory handle subsequent edits.

## Download and local safety

Persist the authenticated manifest and expected baseline before filesystem effects. Append one authenticated chunk at a time to .trash/bettersync/stage5-<version>. Checkpoint offset, confirmed prefix and prefix SHA-256. Never concatenate a full download or retain an array of payloads.

On restart verify staged size/digest. The public adapter has no range reader, so prefix verification uses one temporary whole-prefix buffer, released before downloading more chunks. A partial/extra append rebuilds only the disposable stage. Verify final size/SHA-256 and staged disk readback before installation.

Binary installation inspects files sequentially, captures an existing target into its recovery location, preserves divergent captured contents using a verified disk-to-disk conflict copy, copies the stage to an absent destination, then verifies it. Accept the baseline before stage cleanup. A crash after capture/copy leaves the journal, stage and captured original for replay. Ambiguous/new local bytes are preserved. This is recoverable installation, not a claim that portable copy is an atomic filesystem operation. Inline binary replacement and binary deletion use the same disk-preservation boundary, avoiding overlapping full reads of a large local file. Deletion uses local trash.

Markdown retains Vault.process and unsaved-editor protections. Large Markdown uses the chunked wire/stage but ultimately needs text/editor strings; that allocation budget differs from binary buffers. Conflict copies remain ordinary synced files.

## Feed, resource limits and retry

Poll _changes with include_docs=false, limit=200. Skip validated chunk IDs without their bodies and preserve original row counts for pagination. Fetch file manifests at exact reported revisions with JSON _bulk_get batches of 16. Never substitute a current revision for missing historical metadata. Invalid records become bounded rejection descriptors; foreign protocols stop writes. Chunk-only databases do not count as populated vaults during setup.

Native HTTP has one chunk slot, two control slots and a 1 MiB per-request retained-body cap (UTF-16 string accounting). A JavaScript timeout does not free a native slot: accounting/deduplication remain until its actual promise settles, across reconfiguration. Admission precedes another large source read. A stuck chunk leaves bounded control capacity for unrelated work. Native requestUrl can buffer a hostile oversized response before validation; this is not a hard receive-memory cap against a malicious server.

Durable transfer markers contain direction, stage, size, failures, recovery budget and sanitized reason. Interrupted read/hash/verification/install phases pause immediately at startup. Interrupted chunk-network/manifest-commit phases get one durably counted startup recovery; another interruption pauses. Two processing/data failures also pause. Completed offline errors automatically retry with exponential backoff from 1 to 60 seconds; unresolved native timeouts are distinguished. Explicit Retry resets the budget; foreground/reconnect never clears a safety pause. A paused transfer retains its local source and pending journal while unrelated files continue.

No failed state save permits the following risky operation. Advance baselines/checkpoints only after application or durable retention. Dictionaries preserve prototype-named paths and remain database/key bound. There is no second persistence database.

## Limits and retention

Whole ciphertext/multipart amplification is removed. This is not true filesystem streaming, immediate garbage collection, a hard iOS RSS cap or a text-editor memory guarantee. Native reads/copy/crypto/HTTP can allocate internally. One whole source or verification buffer plus bounded chunk work is the intended application-level binary budget; real-device measurements remain required.

No automatic chunk garbage collection. Old/unpublished chunks may still belong to pending work or indefinitely offline clients. File deletion publishes a tombstone, never chunk deletion. Compaction is supported; purge/manual deletion and external replication branches are not. Storage retention is a disclosed preview cost.

E2EE hides metadata/content, not timing, document sizes or access patterns. It does not add freshness against replay of an entire previously valid vault history. No plaintext fallback or weakened integrity is permitted.

See [verification and device checklist](CHUNKED-TRANSFER-VERIFICATION.md), [implementation plan](CHUNKED-TRANSFER-PLAN.md) and [all ten acceptance scenarios](ACCEPTANCE.md).
