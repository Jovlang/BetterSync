# BetterSync 0.5.1 — performance preview

This prerelease speeds up binary processing while preserving schema 5, existing baseline hashes, E2EE authentication, crash recovery and the 200 MiB limit.

## Changes

- Compute compatible binary baseline hashes directly from bounded base64 ASCII buffers, avoiding intermediate strings and conversions. Preserve cooperative yielding and exact existing digests/conflict identities.
- Reuse deeply frozen, validated metadata instead of checking the entire chunk list for every chunk. Deserialized/untrusted inputs still undergo full validation; cryptographic checks are unchanged.
- Avoid no-op journal writes for unchanged files without pending outgoing work. Required write-ahead/checkpoint saves remain intact.
- Add sanitized session timings for reads, hashing, encryption, network, disk and journal persistence to diagnose remaining real-device bottlenecks.

## Measurements and verification

- Paired 88 MiB baseline-hash benchmark: approximately **3.5× faster**, with identical digests.
- Synthetic 88 MiB pipeline without added latency: upload **13.4 → 7.4 seconds**, download **14.6 → 6.6 seconds** compared with historical 0.5 measurements. The full-pipeline comparison is indicative, not a controlled paired experiment or iPhone measurement.
- At 100 ms added RTT: upload/download **53.5/54.1 → 46.8/45.8 seconds**. Sequential network round trips remain a limitation.
- TypeScript, **184 tests**, the browser build and **five isolated CouchDB integration tests** passed. Coverage retains three-client 88 MiB transfers, interruptions/restart, lost acknowledgements, conflicts, deletion and integrity checks.

See the [measurement details](https://github.com/Jovlang/BetterSync/blob/0.5.1/docs/PERFORMANCE-0.5.md).

## Upgrade

Requires **Obsidian 1.12.3+**. Existing **0.5.0/schema-5** installations can replace `main.js` and `manifest.json` in their BetterSync plugin folder and reload Obsidian. **Keep existing `data.json`, recovery keys and database; no reset or migration is needed.** The ZIP contains those two release files.

Schema-4 and earlier installations still require separate fresh test vaults/databases as described in the 0.5.0 release. Do not reuse a schema-4 or LiveSync database with this build.

## Device acceptance

The user confirmed an 88 MB MOV transfer from iPhone to PC on 0.5.0. The performance changes have not yet been measured on physical iPhone. Reverse-direction transfer, interruption/restart and the complete desktop/MacBook/iPhone acceptance checklist remain open. This prerelease is not MVP acceptance sign-off.

One whole source/verification buffer remains necessary through the portable API. Native memory remains a device-testing concern, and old/abandoned chunks are retained without automatic garbage collection. Chunk size, network concurrency and safety checks are unchanged.
