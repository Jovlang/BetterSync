# BetterSync 0.5.7 — Sync activity preview

Open **Sync activity** from the status bar, BetterSync settings, or the command palette. The main status indicator stays simple.

- See which files or folders are uploading, downloading, or being applied. Chunked transfers show progress based on confirmed upload bytes or staged download bytes.
- See unresolved failures with the affected path when known, a plain-language explanation, and retry guidance. Starting a retry does not clear a failure.
- Review the latest 50 activity entries. The log stays in memory on this device, is cleared when the plugin reloads, and never records file contents, credentials, recovery codes, or raw errors.

## Upgrade

Requires Obsidian 1.12.3+. Replace `main.js` and `manifest.json` in the BetterSync plugin folder with the files from `bettersync-0.5.7.zip`, then reload Obsidian. Keep your existing `data.json`, recovery code, and database. The schema-5 protocol and persisted state format are unchanged; no reset or migration is needed for 0.5.x. Schema-4 installations still require a separate test vault and database.

## Validation

TypeScript checks, 207 automated tests, and the production build passed locally. New tests cover chunked upload/download progress, failure visibility and recovery, offline reporting, and bounded activity history. Real desktop, MacBook and iPhone acceptance remains open; this is not a stable or MVP release.