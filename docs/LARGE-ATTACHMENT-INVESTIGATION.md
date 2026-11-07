# iPhone large attachment release blocker — 7 November 2026

Status: **OPEN pending physical-iPhone acceptance.** The 0.5.0 schema-5 prerelease now removes the identified whole-ciphertext/multipart allocation path, uses staged downloads and durable retry isolation, and preserves the 200 MiB limit. [Current protocol](PROTOCOL.md) · [verification and device handoff](CHUNKED-TRANSFER-VERIFICATION.md).

The investigation below records the original schema-4 failure path and the 0.4 safeguards. Its “remaining memory constraint” section describes the pre-schema-5 state, not current code. Archived codecs under src/legacy retain regression coverage only; the plugin bundle does not include them. A whole source/verification read remains, but whole-file AES-GCM and multipart buffering do not. No jetsam/watchdog evidence has yet proven the OS-level cause of the observed termination.

Observed: adding an approximately 88 MB MOV on iPhone caused Obsidian to freeze/restart repeatedly. Recovery required Airplane Mode, deleting the local video, then restoring connectivity. We have no jetsam/watchdog report or stage trace from that run. Memory exhaustion and main-thread blocking are supported failure mechanisms in the code, not a proven attribution of that particular termination.

## Traced pipeline and amplification

1. Obsidian create/modify events formerly called `SyncEngine.changed`, which read and synchronously hashed the complete file outside the serial sync cycle. Multiple events could overlap a transfer with additional whole-file reads. Startup inventories all local paths and baselines and immediately runs a cycle.
2. `ObsidianVault.read` stats the source, checks 200 MiB, and uses `adapter.readBinary(path)`. That API returns a complete ArrayBuffer. The baseline hash is SHA-256 of the legacy base64 representation. Its scratch allocations are bounded, but its entire loop formerly ran synchronously. The loop does not retain one complete base64 file string for raw binary inputs.
3. `SyncEngine.push` retains the source while checking its baseline and current remote revision. `EncryptedRemote.writeContent` borrows the same buffer. `encryptRecord` hashes all plaintext again for the raw SHA-256 integrity field, then `VaultCrypto.seal` calls one whole-message WebCrypto AES-GCM encryption. Source and ciphertext coexist; native crypto can make further copies.
4. **64 KiB is an inline cutoff, not a transport chunk size.** Larger ciphertext becomes one attachment. `EncryptedCouch.put` allocates a complete multipart ArrayBuffer and copies ciphertext into it. Plaintext N, ciphertext N+16, and multipart approximately N coexist at this point: roughly 264 MiB for an 88 MiB source, before Obsidian, WebView, native HTTP and temporary allocations. This is a code-derived allocation estimate, not a measured peak.
5. `requestUrl` accepts a string or ArrayBuffer body, not a stream. Its native request can retain/copy that multipart body. The 15-second timeout releases the JavaScript wait but does not cancel native HTTP. Previously another poll could start an additional request while the old one was alive.
6. The upload writes a single revision-checked CouchDB document with its attachment. The baseline is persisted after acceptance. A final full source read/hash checks for edits during upload. A lost response is reconciled against the changes feed and remote revision; the implementation must not blindly upload again.
7. Incoming operations persist the exact encrypted envelope/revision before filesystem effects. Large attachment journals contain a stub, not the large plaintext/ciphertext/body. State cloning can amplify inline small-file records, but it does not multiply the 88 MB attachment body in the journal.
8. Download is also buffered: exact-revision HTTP ciphertext, whole-message AES-GCM plaintext, integrity hashing, local reads, compare-and-set and recovery-file reads can coexist. Binary replacement preserves intervening edits through the existing rename/recovery journal. No recovery or conflict guarantees have been removed.
9. Formerly no durable upload attempt survived termination. Startup rediscovered the file and immediately repeated the operation. Incoming operations also replayed without an interruption breaker. Foreground/online events called manual Retry, which would have bypassed a pause if left unchanged.

## Implemented safeguards

- Events only enqueue paths. All binary reads originating in sync now occur inside serialized engine work, with an attempt marker before the initial read. Existing filesystem recovery remains inside that operation.
- Incremental baseline and raw SHA-256 hashing yield between bounded units of CPU work. Baseline digests remain byte-for-byte compatible. This improves responsiveness; it does **not** make the source read or AES-GCM streaming.
- A body-free `state.transfers[path]` marker records direction, size, stage, active state, failure count and sanitized reason. Each major stage is awaited durably before entering it. Failure to save prevents that next stage.
- An active marker discovered on restart pauses the binary before its next read. Two caught processing/data failures also pause it. Normal completed offline failures retain automatic recovery; an uncancelled native timeout is distinguished and counts toward pausing. No local source is deleted or changed by the breaker.
- Paused incoming operations retain their journal and revision; unrelated changes-feed rows and uploads continue. Paused outgoing paths remain pending. Inventory includes pending paths even if their local file was deleted while closed, allowing an uncommitted deleted source to clear without being uploaded.
- Explicit Retry resets the attempt budget and requeues retained paths. Foreground and online events perform an ordinary tick and cannot clear a pause. The UI uses Sync error plus an actionable notice; there is no new setting or sync mode.
- The HTTP wrapper prevents duplicate method/URL requests while the earlier native request is unresolved. Other URLs remain usable. The wrapper is retained across plugin reconfiguration. This does not cancel native HTTP or eliminate buffers allocated before reaching HTTP.

## Remaining memory constraint

The installed public Obsidian `DataAdapter` contract exposes `readBinary(path): Promise<ArrayBuffer>`, with no offset, length or read-stream operation. `requestUrl` is also buffered. WebCrypto AES-GCM has no incremental interface, and schema 4 authenticates one whole content message. Breaking that ciphertext into 64 KiB HTTP requests alone would not fix source or encryption buffering.

A complete fix needs a supported, verified mobile range/stream source and bounded encryption/transport/staged download, including authenticated ordering/completeness and atomic manifest publication if the encrypted wire representation changes. Undocumented filesystem URLs, private Capacitor APIs, custom incremental crypto, Node/Electron APIs, or an unvalidated protocol rewrite were not introduced as a purported fix. No evidence currently establishes that 88 MB, or the 200 MiB protocol limit, fits physical-iPhone memory. **This patch must not be described as completing the release blocker.**

## Reproduction diagnostics

Use a disposable encrypted database/vault with the current build. Add the same video on iPhone, edit a small Markdown file during processing, interrupt by backgrounding/killing, then reopen. Confirm the interrupted attachment pauses, the local video remains, unrelated sync works, and explicit Retry safely reconciles a server acceptance. Repeat with connectivity loss and with deletion of an uncommitted pending source while closed.

Console markers use `[BetterSync] transfer` and contain stage, byte size and sanitized retry reason. Durable transfer entries retain the stage before a termination: `local-read`, `baseline-hash`, `plaintext-sha256`, `content-encryption`, `multipart-allocation`, `attachment-upload`, `baseline-save`, `incoming-read`, `attachment-download`, `content-decryption`, `incoming-hash`, `local-recovery`, `local-read`, `conflict-preservation`, `local-write`. There is no genuine upload chunk progress to report in schema 4. Runtime logs do not include plaintext paths, content, credentials, keys or arbitrary errors. The local state already contains paths; share only redacted transfer fields, never the complete plugin data file.

Record iOS/Obsidian versions, source size, last persisted stage, console timeline and any iOS jetsam/watchdog report. No portable iOS JavaScript peak-memory API is available in the used Obsidian contract; desktop Node RSS is not iPhone memory evidence. Capture physical-device memory with native developer tooling if available.

## Automated coverage

`tests/large-transfer.test.ts` uses the production encrypted remote, codec, AES-GCM, multipart assembly, decryption and integrity checks. Its 88 **MiB** fixture (92,274,688 bytes, larger than 88 decimal MB) runs across three simulated clients with a simulated crash after remote acceptance/before baseline persistence, restart quarantine, unrelated sync, explicit retry, no duplicate revision, exact size/SHA-256 validation, truncation and ciphertext corruption rejection. Additional cases cover repeated file failure, reconnect, interruption before multipart upload, deletion while closed, repair/retry, event storms and failed marker persistence. There is no mocked small-file or nonexistent chunked transport shortcut. Portable filesystem recovery remains covered by the existing adapter-backed tests.

`tests/couchdb.integration.ts` additionally exercises an 88 MiB encrypted multipart upload against isolated real CouchDB, loses its acknowledgement, and verifies the committed record, exact size and SHA-256 after download. It is separate from the physical-device acceptance gate. Test keys and contents are synthetic.

All ten scenarios in `ACCEPTANCE.md`, plus this large-file iPhone reproduction, remain required before release.

Verification on 7 November 2026: `npm run verify` passed 149 tests, TypeScript checking and the browser build. `npm run test:integration` passed all four tests, including the 88 MiB case, against CouchDB 3.5 in a dedicated WSL Docker Compose project on loopback port 25984 with no vault mounts. These results do not measure iOS peak memory or satisfy device acceptance.
