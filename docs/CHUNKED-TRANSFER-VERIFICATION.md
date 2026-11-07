# Schema-5 implementation and device handoff — 7 November 2026

Status: **0.5.0 test prerelease, not iPhone-accepted**. Publication as a prerelease does not close the physical-device acceptance gate. The next required platform gate is physical Obsidian testing. Do not install against an existing schema-4 database or reuse its plugin data; preserve the old vault/database intact.

## Root cause and scope of the fix

**Physical-device update after the 0.5.0 release:** the user confirmed that an 88 MB `.mov` sync from iPhone to PC works. Record this as a successful representative upload on real devices. Independent hash comparison, exact byte count, device/OS versions, interruption/restart, repeated-failure isolation and download to iPhone were not reported; full device acceptance remains open.

The 64 KiB value in schema 4 was an inline cutoff, not streaming. Its large-file upload retained the whole Obsidian source, one whole AES-GCM ciphertext and another whole multipart body. For 88 MiB this is approximately 264 MiB before native copies, hashing/runtime overhead and other app memory. The download/replacement path could retain multiple whole buffers too. Startup rediscovery/replay previously repeated the same risky operation; 0.4 added a breaker but did not remove the allocation amplification. The original phone run supplied no jetsam/watchdog trace, so the precise OS termination mechanism remains unproven.

Schema 5 now uses 256 KiB independently authenticated chunks, durable version/IDs, create-only reconciliation and a revision-checked encrypted manifest published last. A source is read once for transfer, released, then reread to detect concurrent changes. Downloads append authenticated parts to disk, verify SHA-256/size, and install with captured-original recovery and disk-to-disk conflict preservation. Small remote binary replacements and deletion also use disk preservation. Ordinary Markdown retains its editor guards.

The same serial engine services eligible small files between chunk quanta. Native HTTP keeps actual outstanding requests accounted after timeout, with one chunk slot and two control slots. Persistent stage-aware recovery permits one network-phase startup resume, then pauses on another interruption; read/install interruptions pause immediately. Completed offline responses use bounded retry backoff. A failed file retains its source/journal and does not block unrelated files. Logs omit paths, IDs, digests, keys and arbitrary exceptions.

Remaining limits: public Obsidian reads still materialize one whole source/verification buffer; native copy/read/HTTP and garbage collection need real-device measurement. Large Markdown has additional text/editor allocations. Hostile oversized HTTP responses cannot be capped before native buffering. No remote chunk GC is implemented, so old/abandoned versions retain storage. No migration, compatibility mode, algorithm setting or UI expansion was added.

## Automated evidence

- `npm run verify`: TypeScript, 180 tests and browser build pass. The original 149 tests retain historical schema-4 regression fixtures; 31 additional tests cover schema 5 and bundle isolation.
- `npm run test:integration`: five tests pass against isolated CouchDB 3.5 in WSL Docker, loopback port 25984, project `bettersync-schema5-test`, no vault mounts. The schema-5 case transfers 88 MiB through real HTTP across three disk-backed clients, injects lost chunk/manifest replies, restarts, verifies exact bytes, compacts, then deletes without purging chunks. Final rerun: about 98.7 seconds for that case.
- Browser bundle imports only Obsidian and contains neither the legacy crypto domain nor multipart assembly. Historical modules under `src/legacy` are test fixtures, not a runtime mode.
- Independent Node HKDF/AES-GCM decryption checks the wire construction. Tests reject plaintext bypass, swapped vault/file/version/index/ID/count/length context, duplicate chunk IDs, rewritten generations, missing/corrupt parts and wrong final SHA-256.
- Recovery tests cover partial append, lost commit reply followed by local deletion, same-size source change, source deletion before publication, repeated startup interruption, persistence failure, captured-original/copy crashes, malformed checkpoints, automatic reconnect and explicit retry. Other Markdown and attachments continue; immutable chunk count and manifest revision checks detect duplicates.
- Boundary tests exercise 0/1 byte, 64 KiB ±1, 256 KiB ±1, exact multiples and >200 MiB rejection before the source read. Full benchmarks also transfer 88 decimal MB, 88 MiB and 200 MiB using the actual encrypted/staged pipeline.

These results are desktop Node/synthetic-host evidence. They do not test actual Obsidian iOS append/copy behavior or establish mobile RSS/latency. All ten real-device acceptance scenarios remain NOT RUN.

## Size and latency measurements

Windows, Node v26.13.0; real production crypto/engine/journals/Obsidian adapter code with synthetic HTTP and a disk-backed adapter host. One trial per case, with some other verification running concurrently. Values are observations, not performance guarantees. Aggregate records are in [chunk-benchmarks.jsonl](chunk-benchmarks.jsonl).

| Source size | Chunks | Upload | Download | Largest chunk JSON request |
|---|---:|---:|---:|---:|
| 8 MiB | 32 | 1.42 s | 1.21 s | 349,667 B |
| 32 MiB | 128 | 5.24 s | 5.18 s | 349,667 B |
| 88,000,000 B | 336 | 14.09 s | 13.47 s | 349,667 B |
| 88 MiB | 352 | 13.40 s | 14.64 s | 349,667 B |
| 200 MiB | 800 | 35.36 s | 31.12 s | 349,667 B |

The recorded source lease equals one source size, drops to zero after upload, and the largest plaintext chunk remains 262,144 bytes. Final one-file journals are 319–321 JSON characters; this is **final state**, not maximum in-flight journal volume. Incoming/outgoing payload bodies are excluded by their production descriptors; metadata grows with bounded chunk count. Node process RSS samples range from approximately 229 to 1,172 MiB across these runs because the test server retains all ciphertext (including an extra revision-map copy), fixtures/adapter reads allocate Node buffers, and garbage collection is uncontrolled. These RSS numbers must not be presented as plugin-only or iPhone memory measurements.

For 1,000 ~0.5 KiB Markdown notes:

| Added RTT/request | Upload | Download | Upload requests | Download requests |
|---|---:|---:|---:|---:|
| 0 ms | 2.55 s | 2.99 s | 2,001 | 103 |
| 50 ms | 125.39 s | 9.41 s | 2,001 | 103 |
| 100 ms | 220.01 s | 14.03 s | 2,001 | 103 |

Download includes initial setup/probes and 92 `_bulk_get` calls; manifests are batched, not fetched one per note. Upload still uses a precondition lookup and PUT for each changed note; this work does not introduce bulk-write semantics. Unchanged startup inventory no longer performs one remote lookup per file. These production measurements differ in fixture/workflow from the historical schema-4 transport-only experiment, so they are not a controlled speedup comparison.

For 88 MiB at 50 ms added RTT, upload/download took 35.01/35.36 seconds (363/355 requests); at 100 ms, 53.48/54.07 seconds (368/355 requests). Extra upload requests are due metadata polling during the longer transfer. Both retain exactly 352 chunks and the same 349,667-byte maximum request. Synthetic timings cannot establish UI responsiveness; the test that inserts a note during the large upload separately verifies that it commits before the video manifest.

## Physical-device next step

1. On iPhone with Obsidian **1.12.3 or later**, create a disposable test vault and fresh dedicated schema-5 database. Install the locally built `main.js` and `manifest.json` on all test clients. Do not copy old `data.json` or point this preview at the existing schema-4 database. Use the existing setup/recovery-code flow.
2. First transfer a >64 KiB binary and replace it. Confirm that public append, copy-to-absent, rename, mtime and local trash work on iOS. A missing append capability must stop sync with an actionable error, without a whole-file fallback.
3. Add the original approximately 88 MB MOV on iPhone. Edit a small note and add another small attachment while it transfers. Require usable Obsidian, small-file progress before video completion, eventual Synced and identical size/SHA-256 on desktop/MacBook. Repeat a large download to iPhone, plus a concurrent binary edit/conflict.
4. Interrupt at several points by backgrounding and force-quitting. Reopen with pending upload/download. Network-phase recovery may resume once; repeated interruption or risky-phase interruption must pause that file, preserve its local data and let Obsidian/other sync start. Retry must reconcile stable IDs without duplicate/corrupt records.
5. Exercise Airplane Mode/reconnect, repeated server failure, deletion of an unpublished local source before retry, and deletion after a lost final reply. Verify no resurrection or silent loss. Paused transfers are reset only with explicit Retry.
6. Capture iOS/Obsidian versions, source byte size, last sanitized stage/progress, request counts/held-byte diagnostics and jetsam/watchdog/native memory evidence where available. Persisted stage markers distinguish local-read, source-hash, chunk-network, source-recheck, manifest-commit, stage-verification and local-write. Console markers add chunk-encrypt, chunk-request and confirmed/staged ordinals. No portable iOS peak-RSS claim is made. Share redacted fields, never the whole plugin data or recovery key.
7. Complete [all ten desktop/MacBook/iPhone acceptance scenarios](ACCEPTANCE.md), including the previously reported initial-materialization stall criteria. Only then consider closing the release blocker or publishing a release.

Reproduce automation with `npm run verify`, the isolated-server integration command in [TESTING.md](TESTING.md), and `npm run benchmark:chunks -- large|notes|latency` (choose one argument). No production vault database was used for this work.
