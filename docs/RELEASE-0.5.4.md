# BetterSync 0.5.4 — dotfile exclusion compatibility preview

This prerelease excludes every file or directory whose name starts with `.`, at any depth. Examples include `.env`, `.git/`, `.aws/credentials` and `folder/.secret`. There is no selective-sync mode or new setting; this is the single fixed sync scope.

## Safety and compatibility

- Local dotfiles and dot-directories remain untouched. They are not uploaded, downloaded, renamed or deleted by BetterSync.
- On upgrade, obsolete baselines, incoming journals, transfer markers and outgoing checkpoints for excluded paths are removed before transfer recovery or dirty-path reconstruction.
- The same vault-owned path predicate covers dotfiles and a custom Obsidian configuration directory even when that directory has a normal non-dot name such as `Settings/`.
- Authenticated schema-5 live records and deletion markers written by older builds are recognized and skipped rather than quarantined as corrupt. Existing remote ciphertext and deletion markers are not purged; BetterSync has no automatic remote garbage collection.
- An excluded interrupted download attempts to remove its private stage before its journal is forgotten. If that removal fails, sync continues and a sanitized diagnostic records that the internal orphan was retained.
- The schema-5 wire format, encryption, database binding, conflict behavior and 200 MiB limit are unchanged. The desktop empty-directory compatibility fallback from 0.5.3 remains in place.

## Validation

- TypeScript, all **200 automated tests** and the production browser build passed locally.
- Schema-5 regressions cover root and nested dotfiles, a hidden directory tombstone already queued in incoming state, an interrupted staged hidden-file download, a custom non-dot configuration directory, local-file preservation, and both live and deleted hidden remote metadata.
- GitHub Actions runs the same checks plus all five isolated CouchDB wire tests against its disposable CouchDB 3.5 service. Automated and wire tests support this prerelease but do not replace real-client acceptance.

## Upgrade

Requires Obsidian 1.12.3+. Replace `main.js` and `manifest.json` from `bettersync-0.5.4.zip` in the BetterSync plugin folder, then reload Obsidian. Keep existing `data.json`, recovery keys and database for 0.5.x installations. No reset or protocol migration is required. Older schema-4 installations still require separate test vaults/databases.

Dotfiles previously uploaded by an older 0.5.x build remain encrypted in CouchDB but are ignored by 0.5.4. Do not manually purge BetterSync documents or chunks: indefinitely offline clients and pending operations can still require retained records.

## Device acceptance

The complete ten-scenario acceptance checklist on real desktop, MacBook and iPhone clients remains open. Dotfile exclusion and custom configuration-directory migration also need confirmation on those real clients. This compatibility prerelease is not MVP acceptance sign-off.
