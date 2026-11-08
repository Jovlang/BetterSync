# 0.5 performance investigation — 8 November 2026

The user reports that sync works, including an 88 MB MOV from iPhone to PC, but is slow. Actual elapsed time and the dominant slow workload have not yet been supplied. The initial assessment below inspects released 0.5.0. The subsequently authorized optimizations are documented under “Implemented improvements” and included in the 0.5.1 performance prerelease.

## Evidence and likely costs

1. **Sequential network round trips.** 88 MiB has 352 chunks (88 decimal MB has 336). Upload waits for each create-only PUT; download waits for each read. At 100 ms RTT, 352 requests alone cost about 35.2 seconds per leg, before bandwidth, CPU, disk and control requests. Existing synthetic measurements at 100 ms added RTT were 53.48 seconds upload and 54.07 seconds download. These are separate legs: iPhone → CouchDB → PC requires both, because publication happens after all upload chunks are confirmed. They are not physical-phone measurements.
2. **Expensive compatible baseline hashes.** `hashAsync(ArrayBuffer)` computes SHA-256 over base64 ASCII, using spread/fromCharCode, btoa and TextEncoder per block. The wire integrity digest separately hashes raw bytes. A fresh large upload computes a baseline hash, raw manifest hash and another baseline hash during source recheck; the engine unconditionally requeues the accepted path, causing another source read/baseline hash on a subsequent cycle. This last read protects edits during manifest publication and cannot simply be removed. Download staging and installed-target verification each compute both hashes, with further inspections for conflicts/recovery.
3. **Frequent persistence.** Each chunk quantum checkpoints the full state; for 352 chunks the four-chunk threshold alone is 88 checkpoints, more when the one-second threshold triggers earlier. Transfer stages add saves. StateStore structured-clones the full state per save, and production persists plugin data. The synthetic host uses in-memory state persistence, so existing timings do not measure iOS saveData cost. Required write-ahead boundaries must remain durable.
4. **Small-file upload RTT scaling.** The existing 1,000-note benchmark issues 2,001 upload requests (lookup then PUT per changed file, plus feed). At 100 ms added RTT this measured 220 seconds, versus 14 seconds download using batched manifest retrieval. This is a separate bottleneck from binary hashing.
5. **Additional work to profile.** Every chunk validates/copies the complete manifest chunk-ID list again, making this validation quadratic in chunk count. Metadata authentication is also repeated between layers. Every engine cycle scans/stat-checks the vault, and idle polling adds up to roughly three seconds before work starts. Per-chunk debug messages add overhead. Their individual contributions have not been measured.

## Isolated hash experiment

On this Windows development machine, Node v26.13.0, 88 MiB input:

| Operation | Observed elapsed time |
|---|---:|
| Current baseline hash, two runs | 5.36 s / 5.13 s |
| Raw SHA-256, two runs | 0.90 s / 0.79 s |
| Current baseline hash on patterned bytes | 5.01 s |
| Prototype: emit base64 ASCII directly into a reused bounded byte buffer, then hash | 1.49 s |

The prototype preserved the exact baseline digest at lengths 0, 1, 2, 3, 32765, 32766, 32767, 65537 and 88 MiB. It kept the existing 8 ms cooperative-yield budget and avoided intermediate strings; it did not switch to raw hashing or change schema/conflict names. This was an isolated in-memory experiment, not a shipped change or measured end-to-end speedup. Broader regression and real-device validation are still needed.

## Recommended implementation order

1. Add aggregate timings/counts for read, baseline hash, raw hash, crypto/encoding, HTTP wait, durable save, append, verification and install. Keep paths/identifiers/content out of diagnostics. Measure upload and destination completion separately.
2. Replace the string-heavy baseline hashing with bounded direct base64-byte hashing while preserving every digest. This is the best demonstrated low-risk CPU improvement and requires no schema change. Extend compatibility tests across random data, padding and block boundaries.
3. Validate immutable transfer metadata once at the trust boundary and reuse an internal verified context. Avoid redundant saves only when no required durable state transition is lost. Review post-publication rechecks with event/version accounting, retaining concurrent-edit and lost-response guarantees.
4. If network RTT remains dominant, benchmark a fixed bounded two-request chunk window or tightly capped batches. Preserve authenticated chunks, immutable IDs, a contiguous durable confirmed prefix, native timeout accounting, small-file capacity and manifest-last publication. Do not introduce unbounded parallelism or larger whole-file buffers. This can retain schema 5, but needs recovery tests and iPhone memory evidence.
5. For many small files, batch precondition lookups and consider bounded writes with individual revision/result handling. A bulk response is not an atomic file batch; durable recovery must track each result. Avoid adding a user-visible performance mode.

Keep full SHA-256 verification, source-change detection, crash markers and safe installation. Neither increasing chunk size (a format change) nor dropping verification is justified by these measurements. Use the existing 88 MiB three-client, corruption, restart, deletion, timeout and conflict tests as optimization gates, plus isolated CouchDB integration and physical-phone timing/memory checks.

## Implemented improvements

- Both synchronous and asynchronous binary baseline hashing now write base64 ASCII directly into one reusable scratch buffer, capped at 43,688 bytes. No intermediate strings, spread conversions or UTF-8 copies. Exact SHA-256 baseline/conflict identities and the asynchronous 8 ms yield budget are preserved. Concurrent calls have independent scratch buffers.
- Validated metadata is copied and deeply frozen (including its chunk-ID array), then tracked in a private WeakSet. The complete list is validated once per immutable snapshot rather than again for every chunk. Deserialized state and network inputs cannot acquire trusted status without full validation. Cryptographic authentication, context/index checks and final size/hash checks still run. Restored outgoing metadata is replaced with its validated snapshot.
- An unchanged file with no outgoing operation no longer triggers a no-op state save. Clearing a pending outgoing operation still requires a durable save. Write-ahead phase markers, confirmed-prefix checkpoints and post-publication source rechecks are unchanged.
- Aggregate performance diagnostics measure source reads, baseline hashing, metadata preparation, chunk encryption/encoding, chunk network requests, appends, stage verification and installation. StateStore separately counts saves and times state cloning and awaited persistence. Counters are bounded, in memory and reset with their owner; no contents, identifiers or paths are logged or persisted by this instrumentation.

After large transfer attempts the console emits `transfer performance scope=session`. Times/call counts are cumulative for that remote instance, not exclusive per-file timings; journal counters belong to its current StateStore. Failed timed operations are included. `encrypt` includes codec/encoding work, `downloadRequest` includes authentication/decryption, and verification/install contain their own disk reads/hashes. These categories are not a CPU-only profiler and do not include every operation (for example final manifest HTTP). They distinguish practical stage costs without exposing sensitive metadata.

These changes remain schema-5 and baseline compatible with 0.5.0; no fresh database, key change or migration is required for an existing 0.5 installation. One chunk request at a time and the existing native timeout/resource limits remain. Network RTT and per-file small-note upload requests are therefore still limitations; no new concurrency, bulk-write semantics or durability tradeoffs were introduced.

## Validation and reproducible measurements

`npm run verify` passes TypeScript, 184 tests and the browser build. Five integration tests pass against the dedicated `bettersync-performance-test` CouchDB 3.5 container in WSL (loopback 25984, no vault mounts); the container/volumes were removed afterward. Coverage includes the real 88 MiB three-client upload, lost replies, restart, compaction, deletion, unrelated progress and exact-byte checks. New tests independently compare baseline digests across padding/block boundaries and 88 MiB, verify cooperative yielding/concurrent calls, reject mutation/untrusted metadata, retain AAD substitution rejection and count avoided no-op saves.

Use `npm run benchmark:hash` for a paired comparison with the exact historical 0.5 hashing algorithm, alternating execution order. The three measured 88 MiB runs on Windows/Node v26.13.0 were 4.98/4.92/5.08 seconds before and 1.34/1.42/1.49 seconds after: about **3.5× faster** on average, with identical digests. This is a hash-only result, not a promised whole-transfer speedup.

The full encrypted/staged size and latency runs use `npm run benchmark:chunks -- large` and `npm run benchmark:chunks -- latency`. New runs were sequential, after the suites finished; historical 0.5 runs had some concurrent verification. Their comparisons are indicative, not a controlled paired experiment. Raw observations are retained separately in `performance-benchmarks.jsonl`; historical results remain unchanged in `chunk-benchmarks.jsonl`. Synthetic HTTP retains ciphertext in-process, so its RSS is not plugin-only or iPhone memory. Physical iPhone speed, memory and responsiveness still need validation.

| Synthetic case | Historical upload / download | Optimized upload / download |
|---|---:|---:|
| 8 MiB, no added RTT | 1.42 / 1.21 s | 0.69 / 0.67 s |
| 32 MiB, no added RTT | 5.24 / 5.18 s | 2.70 / 2.47 s |
| 88 decimal MB, no added RTT | 14.09 / 13.47 s | 6.99 / 6.49 s |
| 88 MiB, no added RTT | 13.40 / 14.64 s | 7.40 / 6.62 s |
| 200 MiB, no added RTT | 35.36 / 31.12 s | 16.10 / 14.68 s |
| 88 MiB, 50 ms added RTT | 35.01 / 35.36 s | 28.15 / 28.53 s |
| 88 MiB, 100 ms added RTT | 53.48 / 54.07 s | 46.85 / 45.81 s |

All size cases retain the same 349,667-byte maximum chunk JSON request, 262,144-byte plaintext chunk and one-source accounting. The CPU improvements do not remove the network round-trip floor or prove lower native iOS RSS. Post-commit rechecks remain outside the benchmark's first upload tick; time until the UI reports Synced can include another poll/read.

The release package is `bettersync-0.5.1.zip` (main.js and manifest.json). Test it on the existing schema-5 test vault/database, preserve plugin data/recovery keys, and compare the same 88 MB movie in both directions. Record elapsed time and the sanitized performance summary; repeat restart/retry checks before promoting it.
