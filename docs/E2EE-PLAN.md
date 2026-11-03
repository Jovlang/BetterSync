# E2EE implementation plan

Date: 3 November 2026. Status: implementation started; experimental crypto/codec and key-setup foundation, not connected to sync or security-reviewed. Schema 4 is not frozen.

The user authorized implementation after reviewing this plan. Keep the current product contract accurate until E2EE is connected to sync and verified. This plan adds one encrypted protocol, not an encryption toggle, a second sync model, device registration, or algorithm settings.

First increment: `src/crypto.ts` and `src/encrypted-protocol.ts` implement the experimental attachment candidate; `tests/encryption.test.ts` covers independent Node-crypto interoperability and adversarial cases. `tests/benchmark-fixtures.ts` and `npm run benchmark:e2ee:codec` provide synthetic fixtures and a codec microbenchmark, not the required initial-sync/device measurements. See `E2EE-BENCHMARKS.md`. Existing three-client engine tests still exercise the plaintext protocol.

Second increment: `src/encryption-setup.ts` implements draft recovery codes, authenticated vault configuration and a serial, resumable setup coordinator behind injected persistence/secret/remote interfaces. Tests exercise three installations, competing creators, lost responses, offline/restart boundaries, failed local saves and missing-key recovery. Do not call `createConfirmed` before recovery-code backup confirmation, and do not start file transfer before setup and the separate upload/download confirmation complete.

Third increment: `src/obsidian-secrets.ts` adapts Obsidian SecretStorage with capability checks, sanitized failures and write/readback verification; `src/couch-configuration.ts` implements configuration lookup, fresh-database checks and create-only configuration PUT through the shared portable `src/couch-http.ts` transport. The setup adapter rejects native configuration tombstones and databases with live/deleted documents. Generated secret references now use 16 random bytes encoded as lowercase hex because Obsidian rejects uppercase/underscore IDs; earlier draft references are not accepted. Installed typings mark SecretStorage as available since 1.11.4, but actual platform persistence and minimum-version validation remain outstanding. The manifest minimum stays unchanged until the feature is integrated. User confirmation UI, durable setup-state wiring, credential migration, encrypted file transport, engine/journal integration and the full benchmark prototype remain to implement. The new real CouchDB setup test is included in the integration suite but has not been run for this increment.

The draft recovery code is `bse-draft1.<16-byte vault ID>.<32-byte root key>.<6-byte checksum>` with canonical unpadded base64url fields. The checksum is the first six SHA-256 bytes of the length-prefixed version/vault/key fields; it detects accidental corruption and provides no authentication. The encrypted configuration validates the imported key. A prepared intent contains only a secret reference, database/vault binding and encrypted configuration. Secret readback and intent persistence must succeed before remote creation; ready-state persistence must succeed before setup returns. Lost responses resume by authenticating the existing configuration. A ready client never recreates absent configuration. Secret writes preceding a failed intent save may leave an unused local secret; no remote write is authorized and cleanup must not delete shared secrets automatically. The remote adapter must enforce create-only configuration writes and reject foreign/nonempty databases; a preflight emptiness check does not provide a transaction against external administrative writes, which remain unsupported.

The draft implementation uses a separate protocol domain (`bettersync-e2ee-draft-1`), 16-byte random vault identity, a provisional 4 KiB UTF-8 path bound and 16 KiB metadata bound. It derives operation keys directly from the imported HKDF root with vault/record/purpose separation rather than introducing an intermediate record-root key. This is a provisional construction to review, not a compatibility promise. Neither draft records nor their keys should be used for real vaults.

## 1. Outcome and security boundary

Encrypt note and attachment contents, filenames, directory paths, modification timestamps, plaintext sizes and plaintext hashes before HTTP. Include conflict copies, empty files, directory records and persistent deletion markers. Preserve the serial sync loop, optimistic revisions, offline editing, ordinary conflict files, guarded writes and durable incoming journal.

An observer with the CouchDB database, HTTP application logs or database backups must not recover plaintext or keys. Authenticated encryption must reject altered records and attachment substitution before filesystem effects. HTTPS and database authentication remain required.

Explicit limits:

- The server still sees database identity, opaque document IDs, revision history, traffic timing, record counts, ciphertext lengths and attachment presence. Stable IDs reveal repeated activity on the same path. Without padding, lengths reveal approximate plaintext size; attachment absence reveals records without file content.
- Local vault files, editor buffers, trash and recovery files remain plaintext. E2EE is not local disk encryption. An unlocked or compromised client, malicious plugin, or stolen encryption key can expose the vault.
- A malicious server can suppress, delete, replay or fork valid history. AEAD proves authenticity, not freshness or completeness. Local revision checks protect normal concurrency; they do not establish a trusted global history. No claim of rollback resistance, forward secrecy, or per-device attribution/revocation.
- All installations share a vault secret. Anyone with it and write access can author valid records. Lost secrets cannot be reset by the server. Existing plaintext backups cannot be retroactively encrypted.

## 2. Key and onboarding design

Use a cryptographically random 256-bit vault root key, never the CouchDB password or a user-chosen passphrase. Encode a versioned recovery code containing the root key, a random vault UUID and a checksum for typing errors. The checksum is not authentication. Pin the precise encoding and test vectors before implementing it.

New vault flow: validate connection and empty database; generate the code locally; ask the user to save it and confirm possession; persist the secret successfully; then commit encrypted vault configuration and begin the existing upload/download setup. Cancel before confirmation must leave both local files and server unchanged. For two empty sides, key backup is still required. Key setup is a deliberate one-time addition to the product contract; normal restarts require no recovery ceremony.

Joining flow: enter the code, authenticate the server's vault configuration, persist the secret, and perform the existing conservative initialization. Reject a populated local vault against populated remote data. No approval from another client, device list or registration record.

Store the code through Obsidian SecretStorage; keep only its local reference in plugin data. Move the database password to the same API, verifying the secret save before removing the old plaintext field. Do not silently fall back to plaintext key storage. Probe supported desktop/mobile versions, raise minAppVersion to the verified minimum, and block enabling sync if the API is unavailable. Current installed typings expose SecretStorage, but that does not prove compatibility with the currently declared minimum 1.8.7.

SecretStorage is a local vault-scoped store accessible through plugin APIs, not an isolation boundary against other plugins or a promised hardware-backed keychain. Verify actual persistence after app/iPhone restart. Use imported non-extractable operational CryptoKeys where supported; minimize raw-key lifetime without promising JavaScript memory erasure. A user-initiated reveal/copy action enables adding another installation. Never put keys in URLs, logs, notices, telemetry, fixtures or clipboard automatically.

Recovery: import the saved code into a fresh installation. If an existing installation still has the key, explicitly export it. If every key copy is lost, only a plaintext vault/backup can seed a new encrypted database. If a key is compromised, use a new key and fresh database and revoke old database access; no in-place rotation or per-device cryptographic revocation in this release.

## 3. Fixed cryptographic suite

Use Web Crypto: AES-256-GCM with 128-bit tags, HKDF-SHA-256 for key separation, HMAC-SHA-256 for path identities, and crypto.getRandomValues for randomness. No custom primitives, runtime Node/Electron imports, or automatic alternate suite. Unsupported platforms fail closed. These primitives are specified by the [W3C Web Cryptography API](https://www.w3.org/TR/webcrypto/); real Obsidian runtime support remains a release gate.

Derive independent vault configuration, path-ID and record-root keys from the root key with the vault UUID as salt and fixed versioned purpose labels. Define an unambiguous, length-prefixed binary encoding for derivation context and authenticated additional data (AAD); do not depend on incidental JSON property order.

- ID: `e4:` plus base64url of HMAC(path-ID key, domain label + exact UTF-8 path). Preserve case and Unicode bytes, including the existing trailing slash for directories. Never expose base64 paths or unkeyed path hashes.
- Each new record encryption attempt gets a fresh random 256-bit write salt. Derive distinct metadata and content AES keys from the record-root key, salt, document ID and purpose labels. Each encryption also gets a random 96-bit GCM nonce. No shared counters or clocks; nonce/key uniqueness must survive crashes and concurrent clients.
- Bind schema version, vault UUID, document ID, write salt and purpose in AAD. Use a distinct configuration domain. Authentication tags cover all bytes used to decide path, type, deletion or content installation.
- CouchDB assigns `_rev` after submission, so it cannot be the new record's AEAD context. Keep revision preconditions for concurrency and fetch attachments at the exact journaled revision. Do not confuse revision matching with cryptographic freshness.
- Retry either the exact immutable encrypted request with its original revision precondition or re-encrypt with fresh randomness. Never reuse an encryption key/nonce pair for changed plaintext. A timeout never authorizes a fresh-revision overwrite.

Review these constructions and exact encodings independently before freezing schema 4. Add known-answer vectors and cross-runtime interoperability tests, not only encrypt/decrypt round trips.

## 4. Encrypted wire protocol

Add one fixed-ID vault configuration document containing a public protocol identifier, schema and vault UUID plus an authenticated encrypted configuration payload. It contains no root key, wrapped key under a server-known secret, password verifier for a human password, or device list. Keep this document immutable in normal operation.

A schema-4 record exposes only `_id`, `_rev`, protocol/schema identifiers, vault UUID, write salt, metadata nonce/ciphertext, and optional attachment stub. Encrypt a bounded metadata object containing path, object kind, deleted flag, mtime, plaintext byte length, raw content digest and content nonce. The initial candidate uses one encrypted raw attachment named `content` with generic MIME type for every live file, including Markdown and zero-length files. This layout is provisional until the pre-freeze benchmark gate below passes. Directories and deletion markers use authenticated metadata without an attachment. Do not set CouchDB `_deleted` for BetterSync deletions.

The content digest stays inside encrypted metadata. Separate metadata/content keys plus their shared write context bind the attachment to its metadata. Verify its authentication tag, decoded length and digest before installation. Metadata must authenticate before accepting directory creation or deletion. Recompute the keyed ID from the decrypted path and reject any mismatch; then apply existing path and active configuration-directory exclusions. Encryption never makes a path trustworthy by itself.

Keep metadata and attachment atomic in one revision-checked multipart PUT. Keep `_changes` and `_all_docs` attachment-stub-only. Require exact field types, bounded metadata and base64 encodings, expected nonce/salt/tag lengths, one attachment at most, fixed schema, and size consistency before expensive decryption. Keep the 200 MiB plaintext limit; ciphertext adds 16 tag bytes per file, plus metadata and multipart overhead. Define explicit metadata/path bounds and wire-size limits in PROTOCOL.md, with tests; any newly rejected path length is a documented compatibility constraint.

Fresh-database initialization uses a create-only configuration PUT. On 409, read and authenticate the winner; never replace it with the losing key. Persist a resumable local setup intent before remote effects. No file uploads until configuration is authenticated and durable local key/binding storage is confirmed. A missing configuration in an already bound database is an error, never permission to create a new vault.

### Pre-freeze performance gate

**Do not freeze schema 4 until initial-sync benchmarks and encrypted peak-memory measurements on a real iPhone are recorded.** Preserve the current “small vault appears almost instantly” experience if possible without exposing any additional plaintext metadata. Status: NOT RUN; the encrypted implementation and real-device measurements are prerequisites, not results of this plan.

The current Markdown protocol delivers content inline in changes-feed pages. The candidate adds an attachment fetch per file; with serial downloads this can introduce roughly one network round trip per note before crypto and filesystem costs. Treat that as a hypothesis to measure, not an acceptable regression by default. Measure upload and fresh-client download separately, including the first visible usable note and full-vault readiness rather than just HTTP throughput.

Benchmark procedure:

1. Pin the existing plaintext baseline build and each encrypted candidate commit. Use deterministic synthetic fixtures, fresh local state and disposable isolated databases. Never use a user's notes or production database. Include 20 and 100 notes for the small-vault experience, 1,000 and 10,000 for scaling, with a reproducible mix of empty, 0.5, 2, 8 and 32 KiB Markdown files, nested directories and Unicode paths. Add a mixed vault containing attachments. Record exact fixture byte counts and hashes locally.
2. Run through real CouchDB and the actual portable Obsidian HTTP adapter. Compare the baseline and encrypted candidate on the same desktop, MacBook and iPhone, server/proxy configuration and network profiles: measured low-latency LAN, approximately 50 ms RTT and approximately 150 ms RTT with documented bandwidth/loss. Artificial delays belong in the test environment, not plugin runtime. Record actual observed RTT. Exercise one joining client and two simultaneous joining clients.
3. Measure cold initial upload/download and warm restart separately. Start the transfer clock after recovery-code entry and upload/download confirmation; report configuration authentication and time until the next poll separately so setup is not hidden. Record first note readable in Obsidian, 50% and 95% of files installed, all files installed, and final durable Synced status. Count HTTP requests, wire bytes, state-save count/bytes and time spent in crypto, HTTP, journal persistence and vault writes. Keep timing instrumentation free of paths, contents and secrets.
4. Use at least ten paired baseline/candidate runs for the 20/100-note cases, alternating order; report median, range and paired differences without claiming a reliable tail percentile from that sample. Use at least three runs for larger fixtures and costly memory stress cases, reporting every result. Document cache state, device temperature, model, OS/Obsidian versions and other workload. Confirm final file equality and absence of dropped changes after every run.
5. On a physical iPhone, use available native profiling to record Obsidian process memory footprint, idle baseline, absolute peak, incremental peak and post-transfer retained memory; JavaScript heap alone is insufficient because native crypto/HTTP buffers matter. If native measurement is unavailable, mark the memory gate blocked rather than substituting a desktop estimate. Include small-note batches, mixed vaults, and individual 1, 10, 50, 100 and 200 MiB files, both upload and download. Measure conflict preservation, interrupted/restarted transfer, iOS suspension/foreground return and timed-out requests whose underlying buffers may still be alive. Record UI stalls, memory warnings and OS termination as failures, not missing samples.

Working UX targets, to be evaluated against the measured baseline: on the low-latency profile, first note readable within 1 second and the 20-note fixture fully readable within 2 seconds after transfer begins; for both small fixtures, median full-vault readiness no more than baseline plus the greater of 0.5 seconds or 20%. Report elevated-latency regressions explicitly. These are proposed engineering budgets, not claims about existing performance. If the baseline itself misses them, document that fact and retain the relative comparison; do not silently relabel a slow result “almost instant.” A missed target requires another candidate or an explicit documented product tradeoff before freeze.

Set a device-specific memory budget from the measured idle footprint and supported iPhone's observed headroom before selecting the layout. Require no memory warnings, OS termination, lost data or sustained UI unresponsiveness, and no growing retained-memory trend across repeated transfers. Record absolute and incremental peaks for every size; a successful single transfer is insufficient. Do not invent a universal safe iOS memory ceiling or reduce the 200 MiB contract silently.

If one attachment per file misses the small-vault target, compare a bounded inline-ciphertext candidate: store small encrypted file bodies inline with their encrypted metadata, with larger encrypted bodies remaining attachments. Use a fixed internal threshold based only on ciphertext length, applying equally to all file extensions; no plaintext path/type hints, MIME distinctions, hashes or timestamps. Both layouts must have the same authenticated context, encrypted metadata boundary, atomic revision write, exact-revision recovery and tamper rejection. This is a deterministic storage rule within one protocol, not a user-selectable mode. Benchmark JSON/base64 expansion, feed-page byte budgets, journal/state-save amplification and iPhone memory before choosing the threshold. Keep large bodies out of inline feeds and journals. Re-review any storage discriminator and its leakage against the original boundary.

Other candidates may reduce redundant saves or use a small bounded ciphertext-prefetch window with a strict total-byte budget, while applying records serially and journaling before filesystem effects. Benchmark memory and prove checkpoint/crash invariants before adopting either. Avoid unbounded Promise.all downloads, cross-file bundles, plaintext previews, weaker authentication, early installation of unauthenticated bytes or plaintext fallback. Keep the simplest layout that meets the measured UX and memory budgets.

Deliver a benchmark report with reproducible commands/fixtures, build IDs, device/network details, raw timings, memory traces or summaries, confidentiality checks and a selected-layout rationale. Record results in VERIFICATION.md or a linked benchmark report. Only then update this plan and PROTOCOL.md consistently for the chosen layout, obtain security review of any change, and freeze schema 4. Missing iPhone measurements leave this gate open.

## 5. Integration with the existing engine

Current coupling matters: sync-engine.ts constructs schema 1/2/3 documents, calls couch-client.ts validation directly, filters `file:` IDs, and serializes FileDocument into the journal. A transport wrapper alone would leave plaintext paths and payloads exposed.

| File/module | Planned responsibility |
|---|---|
| New `crypto.ts` | Crypto interface, key derivation, random source, keyed IDs, authenticated sealing/opening; injectable deterministic test source only in tests |
| New `encrypted-protocol.ts` | Strict wire/configuration codecs and validation; convert authenticated metadata into logical records |
| `types.ts` | Separate logical records from encrypted wire records and journal records; prevent plaintext records reaching HTTP by type contract |
| `couch-client.ts` | Portable HTTP and encrypted multipart transport; revision-specific attachment fetching; no plaintext serializer in the new runtime |
| `sync-engine.ts` | Consume authenticated logical records; retain existing conflict and compare-and-set behavior; remove assumptions about wire schemas and ID prefixes |
| `local-state.ts` | Versioned state, vault/key binding, bounded encrypted journal and rejected-record diagnostics; serial persistence |
| `main.ts`, `settings.ts` | Serialized setup/key lifecycle, SecretStorage, capability checks and concise errors; same five status values |
| `paths.ts`, `conflict-handler.ts`, `vault-client.ts` | Retain path safety, local digest semantics and filesystem recovery; keep wire identity separate from local content hashes |

Bind state to server/database, protocol version, authenticated vault UUID and a domain-separated key identity. Changing a key or binding must not reuse checkpoints, baselines or journals. Never replace a missing key automatically. Preserve current binary baseline digest semantics so conflict names/replay are stable unless a separately tested local-state conversion is required.

Incoming sequence:

1. Authenticate configuration before any syncing or filesystem recovery that can apply remote data.
2. Validate and decrypt metadata; map it to a safe logical path. Persist the encrypted envelope, exact revision and expected local baseline before filesystem effects. Keep decrypted file bodies out of data.json; local baseline paths remain local plaintext metadata.
3. Fetch the encrypted attachment for that exact revision; authenticate/decrypt and verify limits/digest fully before invoking existing recovery/conflict/write machinery.
4. Preserve divergent local bytes and apply guarded writes as today. Only then save baseline and remove the incoming entry.
5. Advance a feed checkpoint only after durable journaling or durable rejection. A failed attachment remains pending; compaction cannot cause substitution with a newer body. Supersession requires a later valid authenticated record.

Failure scope requires explicit changes: wrong/missing key, configuration mismatch, mixed plaintext/encrypted database or unsupported protocol blocks syncing before uploads. An individually corrupt record produces Sync error while unrelated valid records progress. Persist its opaque identity/revision and bounded diagnostic information, not attacker-controlled raw payloads. Block writes to that identity until a valid authenticated record resolves it; because path IDs are deterministic, this works even when its path cannot be decrypted. Never interpret decryption failure as absence or deletion. Verify quarantine behavior across restart, Retry and later valid revisions.

Remove path/record payloads from console logging (main.ts currently logs paths). Log fixed categories only; never raw server responses, decrypted metadata, plaintext hashes, authentication headers or key material. Local notices may identify a conflicted note without including contents or secrets.

## 6. Existing-vault transition

Do not encrypt an existing CouchDB database in place. Old revisions, attachment history, replication and backups can retain plaintext; rewriting documents is not erasure. Do not add mixed-mode operation or silently accept legacy schemas in an encrypted vault.

The first release supports a deliberate fresh-vault cutover:

1. Finish syncing every available old client, preserve conflicts and back up local vaults. Explicitly account for unsynced edits on offline clients; an unavailable client prevents claiming a complete cutover.
2. Disable old syncing on all clients and revoke their old database write access. Preserve an offline copy of the old vault/data for recovery. Server/database administration remains external to the plugin.
3. Create a dedicated empty encrypted database outside BetterSync. Use a new local vault seeded with the reconciled source files, excluding plugin configuration/state/trash; install the E2EE build and initialize a new key. This respects the existing prohibition on silently rebinding initialized installations.
4. Join from fresh empty vaults on MacBook/iPhone with the same recovery code. Do not copy data.json. Compare a local inventory of paths, kinds and raw-byte digests across all three clients before retiring the old setup.
5. Explicitly document disposition of the old plaintext database, snapshots, proxy logs and backups. Do not automatically delete them or claim their historical exposure is undone.

Late offline edits from the retired vault require explicit local reconciliation into the new vault. Never attach an old baseline to the new database. Rollback retains new edits in a local backup before any manual reconciliation; it must not resume two sync engines against the same vault. Key compromise recovery uses this same fresh-database procedure, with a newly generated key.

## 7. Implementation order and merge gates

1. **Compatibility/security spike.** Verify Web Crypto algorithms, randomness and SecretStorage persistence on desktop, MacBook and iPhone; establish the supported Obsidian minimum. Review the threat model, configuration creation race and recovery-code UX. Establish the plaintext performance baseline and a minimal encrypted end-to-end benchmark prototype before invasive engine changes. Complete the pre-freeze small-file and physical-iPhone memory gate above; select the layout and finalize encoding/bounds only after its results and security review. Do not freeze schema 4 based solely on desktop simulations.
2. **Crypto and codec foundation.** Add fixed suite and logical/wire types, vectors, parser limits and tamper tests. No enabled network path until codec tests pass. Review key/nonce separation and AAD independently.
3. **Transport and engine.** Implement atomic encrypted uploads, exact-revision downloads, encrypted journaling, binding/quarantine and initialization. Run the existing conflict/offline/crash suite against the encrypted protocol. Remove legacy runtime upload paths; keep legacy fixtures for rejection tests.
4. **Secret lifecycle and onboarding.** Implement generation, backup confirmation, import, reveal, missing-key errors, password storage migration and serialized shutdown/configuration behavior. Exercise failures between every local persistence and server step.
5. **Transition and documentation.** Update README, SPEC, PROTOCOL, ACCEPTANCE, VERIFICATION, RELEASING and manifest together. Publish the fresh-vault cutover procedure and explicit limits. Do not turn the current README's “no E2EE” statement into a security claim before implementation verification.
6. **Adversarial and real-device release gate.** Complete isolated CouchDB testing, independent security review, memory measurements and all real-client acceptance scenarios. Record build, versions and results, including unresolved findings.

Each sync implementation change runs `npm run verify`. Run `npm run test:integration` separately against an isolated disposable CouchDB server only, never a user's vault database. This planning-only change requires documentation review, not a claim that runtime tests or real-device tests have passed.

## 8. Required verification matrix

| Area | Required scenarios and assertions |
|---|---|
| Cryptography | Known-answer vectors; wrong key/vault/context; mutations of every authenticated field, nonce, tag and ciphertext; metadata/body swap across paths, vaults and revisions; truncation; no plaintext output on failed authentication |
| Randomness | Concurrent three-client writes; crash/retry and lost responses; fresh derivation salt and nonce for changed encryption attempts; fail closed on random-source errors |
| Parser safety | Unsupported schema, plaintext injection, malformed/oversized metadata, unexpected attachments, forged lengths, excluded/traversal paths, Unicode/case collisions, `__proto__`/`constructor` paths |
| Initialization | Racing creators, wrong recovery code, lost configuration response, secret-store failure, crash after each setup step, missing/changed configuration, both-populated refusal, cancel and empty/empty behavior |
| Sync behavior | Three clients: text, Canvas, binaries, hidden/empty files and directories, rename, delete/edit conflicts, rapid editing, offline updates, stale clients and file/directory replacement |
| Crash recovery | Kill before/after journal save, HTTP acceptance, attachment authentication, conflict preservation, staging/copy/trash and baseline save; no loss, stale resurrection or duplicate conflict explosion |
| Corrupt records | No filesystem effects, no baseline acceptance, no overwrite of quarantined identity, durable checkpoint behavior, unrelated progress, valid replacement/retry and restart recovery |
| CouchDB wire | Real multipart ciphertext, metadata/attachment atomicity, 409, timed-out accepted PUT, revision-specific attachment fetch, compaction, deletion markers, fresh-client restore and pagination |
| Confidentiality | Scan captured requests and disposable database exports (including historical revisions) for distinctive path/content/hash/key canaries; assert only ciphertext/generic metadata crosses HTTP; audit generated errors/logs too |
| Key lifecycle | Normal offline restart without server or prompts; lost local secret restores with code; wrong code causes zero mutation; deliberate export; fresh-key migration; old key cannot open new database |
| Limits and mobile | Zero bytes, below/at/above 200 MiB; metadata bounds; iOS suspension and restart; crypto latency, peak memory and concurrent timed-out request buffers |
| Pre-freeze performance | Paired initial-sync baseline/candidate runs for 20/100/1,000/10,000 small notes; first-note and full-vault readiness, requests and persistence costs across latency profiles; physical-iPhone process memory traces; layout decision before schema freeze |

Use fake clocks/randomness/fault injection only in tests, plus real Web Crypto interoperability on target runtimes. Confidentiality canary scans complement cryptographic review; they are not proof by themselves.

Whole-file encryption adds plaintext/ciphertext and native crypto allocations to the current buffered HTTP/recovery path. Process one file at a time, avoid base64 bodies and extra clones, release buffers promptly, and measure retained timeout requests. No chunks or streaming claims in this release. If near-limit iPhone behavior cannot preserve data and remain usable, treat that as an unresolved release blocker; do not silently lower the fixed limit or expand scope to chunking.

All ten original ACCEPTANCE.md scenarios must pass on real desktop, MacBook and iPhone using E2EE, plus the added confidentiality, recovery, corruption and expanded-file checks. Automated three-engine tests and real CouchDB wire tests do not constitute MVP acceptance. A security reviewer must assess the protocol/key lifecycle before calling it security-reviewed; do not imply a formal audit unless one occurred.

## 9. Reference and decision record

- [W3C Web Cryptography API](https://www.w3.org/TR/webcrypto/): API/primitive definitions; does not establish support inside a specific Obsidian build.
- [Obsidian Store secrets](https://docs.obsidian.md/plugins/guides/secret-storage): local SecretStorage integration and storing references rather than secrets in data.json; does not establish hardware-backed isolation.
- Repository basis: README.md, SPEC.md, PROTOCOL.md, ACCEPTANCE.md and current src/{types,paths,couch-client,sync-engine,local-state,main,settings}.ts.

Recommended defaults are settled in this plan: mandatory encrypted protocol, generated recovery code rather than human password, SecretStorage with a verified minimum version, fresh database/vault cutover, and no in-place rotation. One attachment per file remains a candidate, not a frozen requirement. Remaining implementation gates are concrete: baseline-relative small-file initial-sync benchmarks, physical-iPhone peak-memory measurements and layout selection before schema freeze, exact encoding/bounds review, minimum-version verification and independent security assessment. A requirement for human passphrases, transparent in-place conversion or malicious-server rollback protection would require revising this design before implementation.
