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

## Follow-up: slow but completed 83 MB download on 0.5.1

On 8 November the user reported that an approximately 83 MB MKV eventually completes downloading to iPhone on 0.5.1, after minutes displaying Syncing. Earlier failure messages were reported without exact text. This establishes completion for this transfer, not a diagnosis of those errors or completion of the real-device acceptance checklist. The filename is permitted by the current path rules; the reported size is below 200 MiB.

`npm run benchmark:download` isolates download costs with a generated 83,000,000-byte file and the current production engine, crypto, timeout wrapper and disk adapter. One source upload is reused across four fresh destinations. Added request/save delays are synthetic sensitivity inputs, not observed iPhone timings. Raw results are in `download-performance-benchmarks.jsonl`.

| Added delay per request | Added delay per state save | Time to first Synced |
|---|---|---|
| 0 ms | 0 ms | 6.95 s |
| 100 ms | 0 ms | 41.79 s |
| 0 ms | 100 ms | 16.45 s |
| 100 ms | 100 ms | 50.58 s |

All four runs verified exact destination SHA-256 and completed in the initial cycle, with 327 HTTP requests (317 chunk reads), 94 state saves, 317 data appends plus one empty append for mtime, and two full-file reads totaling 166 MB. Maximum serialized state was 13,208 bytes in this one-file vault; larger vaults can cost more per save. The two reads are stage verification and installed-file verification. They include raw and compatible-baseline hashing; together their timed stages cost about 4.4–5.1 seconds here, while actual read I/O totaled about 0.09–0.12 seconds. This points to hashing/other verification work rather than disk-read latency on this host, not necessarily on iPhone.

The Windows timer overshot the injected 100 ms waits: the network-delay-only run spent 35.19 seconds in the HTTP wrapper, and the save-delay-only run spent 9.98 seconds in state persistence. Report measured totals rather than treating the nominal delays as exact. These are single runs, not statistical estimates. The fixture does not simulate bandwidth limits, native bridge costs, physical iPhone memory pressure, Obsidian filesystem events, or production saveData. Setup/configuration connection precedes timing; first-download initialization is included. No additional cycles were needed here, which does not exclude event-driven rechecks on a real device or subsequent inventory rechecks.

### Next optimization target

The strongest measured target is the serial chunk-request wait: 317 chunks impose a nominal 31.7-second floor at 100 ms per request, before bandwidth/CPU/storage. A fixed two-request download window is worth prototyping next. It must retain the existing per-request size bound, explicitly account for at most two live native requests including timed-out requests, authenticate each chunk, append/checkpoint only a contiguous prefix, stop scheduling after failure, and retain capacity for unrelated small-file work. This is a proposal, not an implemented or measured speedup. Do not merely increase the transport slot limit: the download loop is serial and needs a bounded coordinator with restart/corruption/offline tests and isolated CouchDB verification.

State-save latency is a secondary measured cost. Four-chunk checkpoints alone account for 80 saves in this case; the one-second threshold can increase the count on slower links. Any batching change must preserve write-ahead stages and safe prefix replay. Removing final file verification or trusting mtime/size is not justified by these results.

This investigation adds a reproducible benchmark and documentation only. Plugin runtime, schema, transfer limits and release version remain unchanged. Physical iPhone latency, memory and all ten acceptance scenarios remain separate open checks.

## Implemented follow-up — 0.5.2 download pairs

After the investigation, the user authorized implementation. Downloads now fetch a fixed pair concurrently, wait for both authenticated outcomes, then append in manifest order. A failed member discards the pair without advancing its prefix. No next pair starts before the previous pair has been handled. At most two chunk downloads are admitted; uploads remain exclusive. Timed-out native requests retain their slots and block new chunks until actual settlement, including when only one expired request remains. Two control slots remain independent. There is no setting or format change.

Durable prefix checkpoints, final stage/installed-file verification and conflict preservation remain. Checkpoint accounting uses four newly appended chunks rather than an absolute even boundary, so recovery from a write failure after the first member of a pair also checkpoints correctly. Bounded pair buffering adds at most two authenticated plaintext chunks (512 KiB), plus bounded codec/response work; native/internal allocations and full-file verification buffers still require iPhone measurement.

The same 83 MB experiment produced these single-run observations. Raw follow-up data is in `download-window-benchmarks.jsonl`; preceding data is preserved in `download-performance-benchmarks.jsonl`.

| Added request / save latency | Serial download | Paired download |
|---|---|---|
| 0 / 0 ms | 6.95 s | 6.16 s |
| 100 / 0 ms | 41.79 s | 23.93 s |
| 0 / 100 ms | 16.45 s | 16.42 s |
| 100 / 100 ms | 50.58 s | 34.89 s |

At 100 ms added request latency, wall time falls approximately 43%; with slow saves too, approximately 31%. All cases retain 327 requests, 94 saves, two whole-file verification reads and exact destination SHA-256. This overlaps network waits rather than reducing traffic or durability. State-save-dominated work remains largely unchanged. Runs are synthetic and not statistical/iPhone performance guarantees. The benchmark and `downloadRequest` diagnostic timers sum overlapping requests, so their sum can exceed wall-clock duration after this change.

Validation includes the full verify suite and five isolated CouchDB integration tests. New three-client tests cover reversed reply order, rejected/corrupted pairs, restart/retry, and a partial local write leaving an odd prefix. Transport tests cover the two-read bound, lingering timeout admission, exclusive uploads and independent controls. The existing suite retains 88 MiB transfers, crash/offline recovery, conflicts, corruption and deletion. The real-wire tests ran against a disposable CouchDB 3.5 container on loopback 25985 without vault mounts; it was removed afterward. No personal database was accessed. The 0.5.2 package remains a prerelease pending physical-iPhone speed/memory checks and the complete real-device acceptance gate.
