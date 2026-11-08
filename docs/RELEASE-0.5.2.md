# BetterSync 0.5.2 — faster attachment downloads preview

Downloads fetch a fixed pair of encrypted chunks concurrently, reducing serial network waiting on high-latency connections. Each chunk stays at 256 KiB. Both requests settle and authenticate before the pair is appended in order. Failed pairs do not advance the prefix or schedule later pairs. Uploads remain serial and exclusive; two separate control slots preserve capacity for unrelated work.

Timeouts retain native request accounting until settlement. An expired chunk blocks further chunks even if the other slot is free, preventing repeated retries from accumulating native requests. Final size/hash verification, durable checkpoints, conflict preservation and the schema-5 format remain intact. The pair adds bounded response/crypto buffering; physical-iPhone memory and responsiveness need testing.

## Measurements and validation

- Synthetic 83 MB download with 100 ms added request latency: **41.8 → 23.9 seconds**, approximately 43% less time. With an additional 100 ms per state save: **50.6 → 34.9 seconds**. These are single-run Windows measurements, not iPhone guarantees.
- Exact file hashes, request counts, checkpoint counts and final verification reads are preserved in the benchmark.
- TypeScript, all **189 automated tests**, the browser build and **five isolated CouchDB wire tests** passed, including 88 MiB three-client restart/recovery. New automated tests exercise out-of-order replies, corrupt/failed pairs, partial-write recovery and native timeout bounds.

## Upgrade

Requires Obsidian 1.12.3+. Replace `main.js` and `manifest.json` from `bettersync-0.5.2.zip` in the BetterSync plugin folder, then reload Obsidian. Keep existing `data.json`, recovery keys and database for 0.5.x installations. No reset or migration is required. Older schema-4 installations still need separate test vaults/databases.

## Device acceptance

An approximately 83 MB MKV eventually downloaded to iPhone on 0.5.1, but slowly. This new window has not yet been measured on iPhone. All ten desktop/MacBook/iPhone acceptance scenarios remain the release gate; automated tests and synthetic timings do not establish MVP acceptance.

See [performance results](https://github.com/Jovlang/BetterSync/blob/0.5.2/docs/PERFORMANCE-0.5.md) for measurements and validation.
