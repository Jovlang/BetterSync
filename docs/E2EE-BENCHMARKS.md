# E2EE benchmark groundwork

Status: codec microbenchmark implemented; real initial-sync and physical-iPhone memory gates NOT RUN. Schema 4 remains provisional. Do not use draft records for real vault data.

## Available now

Run with Node.js 22+ after `npm ci`:

```sh
npm run benchmark:e2ee:codec -- 20
npm run benchmark:e2ee:codec -- 100
npm run benchmark:e2ee:codec -- 1000
npm run benchmark:e2ee:codec -- 10000
```

The shared fixture generator yields deterministic ASCII note bodies sized 0, 512, 2,048, 8,192 and 32,768 bytes, with nested Unicode paths. It produces one fixture at a time. Encryption keys are newly randomized per run, kept in memory and never printed. The runner encrypts/decrypts each note between two independent key contexts, verifies the raw-byte digest, and reports only aggregate timings and sizes.

Reported plaintext JSON size is a serialization-size comparison with schema 1, not a timed legacy sync baseline. Encrypted size includes JSON metadata and raw encrypted body, excluding HTTP/multipart/revision overhead. Codec timing includes cryptography, validation and hashing; elapsed time additionally includes fixture generation and equality checks. No HTTP latency is simulated. No filesystem, Obsidian, CouchDB, native-memory or UI-readiness claims can be made from these numbers.

Smoke runs on Windows, Node v26.13.0, 3 November 2026:

| Notes | Plaintext bytes | Legacy JSON bytes | Encrypted envelope + body bytes | Encrypt ms | Decrypt ms |
|---|---:|---:|---:|---:|---:|
| 20 | 174,080 | 182,688 | 186,700 | 13.02 | 10.28 |
| 100 | 870,400 | 913,434 | 933,500 | 38.31 | 38.89 |

These are single smoke runs, not statistical results or acceptance evidence. The 20-note run overlapped a browser-bundle check. Do not use it for a baseline comparison. Rerun paired trials in a controlled environment when the HTTP/Obsidian benchmark is available.

## Required next

Implement an isolated end-to-end benchmark using the same fixtures, the real CouchDB wire path, the portable Obsidian HTTP adapter and real vault writes. Follow the pre-freeze performance gate in `E2EE-PLAN.md`: compare the pinned existing build against the encrypted candidate at measured LAN/50 ms/150 ms RTT, including first usable note, whole-vault readiness, durable Synced, request counts and state-save amplification. Include one and two joining clients, repeated paired trials and final inventory equality.

Measure physical-iPhone total process footprint (idle, peak, incremental and retained), including native HTTP/crypto buffers, at the specified small-note and 1–200 MiB file workloads. Record device/OS/Obsidian/build IDs, trace method, network profile, warnings, stalls, suspend/restart and timeout cases. Node heap or desktop memory numbers cannot replace this gate.

If attachment-per-file fails the small-vault budget, implement and compare the bounded inline-ciphertext candidate from the plan. Preserve the encrypted metadata boundary and revision/journal guarantees. Select and document the layout only after both latency and memory measurements and review.
