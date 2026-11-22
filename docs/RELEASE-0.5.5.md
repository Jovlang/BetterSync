# BetterSync 0.5.5 — faster attachment uploads preview

This prerelease overlaps a fixed pair of encrypted attachment chunk uploads. It targets the remaining request-latency bottleneck without adding a mode or setting, changing the schema, increasing chunk size, or weakening verification and crash recovery.

## Performance

- At 50 ms added request latency, a synthetic 88 MiB upload fell from 27.84 to 18.98 seconds, an observed 31.8% reduction.
- At 100 ms added request latency, the same upload fell from 46.56 to 28.10 seconds, an observed 39.6% reduction.
- Both comparisons retain 352 immutable chunk writes, 256 KiB plaintext chunks and a 349,667-byte maximum JSON request.
- Fresh zero-added-latency runs also showed no regression: 88 MiB uploaded in 6.66 seconds and 200 MiB in 15.40 seconds.

These are single-run Windows/Node synthetic measurements, not statistical estimates or physical-iPhone results. Aggregate request timings overlap after this change and can exceed wall-clock time. Raw observations are retained in `docs/upload-window-benchmarks.jsonl`.

## Safety and compatibility

- At most two attachment uploads or two attachment downloads are admitted at once; upload and download pairs never mix.
- A timed-out native request keeps its slot until it actually settles, preventing unbounded request or ciphertext accumulation. Two control-request slots remain independent.
- A failed pair advances only its contiguous confirmed prefix and durably records that prefix before returning the error.
- Lost upload acknowledgements are reconciled only after both pair members settle, then authenticated against the expected plaintext before progress advances.
- Manifest publication remains last. Existing source rechecks, four-chunk/time-based checkpoints, final hashes, encryption, conflicts and the fixed 200 MiB file limit are unchanged.
- The schema-5 database, recovery code and local state remain compatible with 0.5.x. The 0.5.4 dotfile exclusion and earlier desktop empty-directory workaround remain in place.

## Validation

- TypeScript, all **202 automated tests** and the production browser build passed locally.
- New three-client tests cover reversed upload replies, an offline pair member with a durable one-chunk prefix, restart/retry, timeout retention and direction isolation.
- Existing tests retain lost-acknowledgement recovery, 88 MiB transfers, crash/offline recovery, corruption rejection, conflicts, deletion and unrelated-file progress.
- GitHub Actions passed the same tests plus all five isolated CouchDB wire tests against its disposable CouchDB 3.5 service before release preparation.

Automated, synthetic and isolated-wire results support this prerelease but do not replace physical-client acceptance.

## Upgrade

Requires Obsidian 1.12.3+. Replace `main.js` and `manifest.json` from `bettersync-0.5.5.zip` in the BetterSync plugin folder, then reload Obsidian. Keep existing `data.json`, recovery keys and database for 0.5.x installations. No reset or protocol migration is required. Older schema-4 installations still require separate test vaults/databases.

## Device acceptance

The complete ten-scenario acceptance checklist on real desktop, MacBook and iPhone clients remains open. Physical-iPhone upload speed, memory and responsiveness still require measurement. This performance prerelease is not MVP acceptance sign-off.
