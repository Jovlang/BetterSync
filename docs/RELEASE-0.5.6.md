# BetterSync 0.5.6 — upload diagnostics correction preview

This prerelease corrects the aggregate upload-progress diagnostic introduced with bounded paired uploads in 0.5.5. If the first chunk in a pair failed while the second succeeded, retry authenticated the already existing second chunk and could increment `uploadedChunks` a second time. The counter now advances only with the durable contiguous confirmed prefix, so every chunk contributes once.

## Scope and compatibility

- The counter is in-memory diagnostic data only; it is not persisted or used for sync correctness, encryption, checkpointing or UI state.
- Paired request scheduling, manifest-last publication, chunk encryption, source rechecks, conflict handling and crash recovery are unchanged.
- The schema-5 database, recovery code and local state remain compatible with 0.5.x. No reset or migration is required.
- The stale performance-document test count is also corrected from 198 to 202.

## Validation

- TypeScript, all **202 automated tests** and the production browser build passed locally.
- The upload-window regression now makes the first request fail after the second succeeds, restarts the client, authenticates the out-of-order remote chunk on retry, verifies three-client byte convergence and requires `uploadedChunks` to equal the exact manifest chunk count.
- Existing tests retain timeout bounds, direction isolation, lost acknowledgements, 88 MiB transfers, crash/offline recovery, corruption rejection, conflicts and deletion.

Automated and isolated-wire results support this prerelease but do not replace physical-client acceptance.

## Upgrade

Requires Obsidian 1.12.3+. Replace `main.js` and `manifest.json` from `bettersync-0.5.6.zip` in the BetterSync plugin folder, then reload Obsidian. Keep existing `data.json`, recovery keys and database for 0.5.x installations. Older schema-4 installations still require separate test vaults/databases.

## Device acceptance

The complete ten-scenario acceptance checklist on real desktop, MacBook and iPhone clients remains open. Physical-iPhone upload speed, memory and responsiveness still require measurement. This prerelease is not MVP acceptance sign-off.
