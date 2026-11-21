# BetterSync 0.5.3 — desktop directory deletion compatibility preview

This prerelease adds a defensive compatibility workaround for an Obsidian desktop regression that can make `FileSystemAdapter.rmdir(path, false)` fail while deleting an empty synchronized directory. The failure has been reproduced as `ERR_FS_EISDIR` on POSIX/macOS and may appear as `EPERM` on Windows. Obsidian's API changelog previously recorded a fix for this behavior, so BetterSync treats the current failure as an upstream regression or build discrepancy rather than changing its normal adapter contract.

## Safety and compatibility

- BetterSync still lists the directory first and refuses deletion when it contains a file or folder.
- It still asks the Obsidian adapter to remove the directory non-recursively first.
- Only `ERR_FS_EISDIR` or `EPERM` from a desktop `FileSystemAdapter` activates a lazy native `rmdir()` fallback.
- Native `rmdir()` atomically rejects a directory if a new unsynced child appears after the earlier emptiness check. BetterSync never substitutes recursive removal.
- `ENOENT` from the native fallback is accepted because the requested deletion is already satisfied. `ENOTEMPTY` and every other failure remain visible for retry/diagnosis.
- Mobile and non-filesystem adapters never load or call Node filesystem APIs. The schema-5 wire format, encryption, sync model and database state are unchanged.

## Validation

- TypeScript, all **196 automated tests** and the production build passed locally.
- New regression tests cover normal adapter success, both known desktop errors, a child-created-after-list race, unrelated errors, mobile/non-filesystem adapters and native `ENOENT`.
- GitHub Actions passed the same checks plus all **five isolated CouchDB wire tests** against its disposable CouchDB 3.5 service. Automated and wire tests support the release but do not replace real-client acceptance.

## Upgrade

Requires Obsidian 1.12.3+. Replace `main.js` and `manifest.json` from `bettersync-0.5.3.zip` in the BetterSync plugin folder, then reload Obsidian. Keep existing `data.json`, recovery keys and database for 0.5.x installations. No reset or migration is required. Older schema-4 installations still require separate test vaults/databases.

## Device acceptance

The complete ten-scenario acceptance checklist on real desktop, MacBook and iPhone clients remains open. This compatibility prerelease is not MVP acceptance sign-off. The fallback is covered for both known error codes but still needs confirmation inside affected Obsidian 1.15.1 desktop builds, particularly the Windows `EPERM` manifestation.
