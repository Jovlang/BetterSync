# BetterSync 0.5.8 — Separate sync state preview

Frequent writes for file records, revisions, checkpoints and transfers no longer touch configuration or credential references in `data.json`. BetterSync stores progress in `sync-state.json` and keeps its previous verified snapshot in `sync-state.backup.json`.

If the current snapshot is missing or damaged, BetterSync pauses instead of replaying a potentially stale checkpoint or treating the vault as new. Keep both files for recovery. The portable Obsidian adapter does not guarantee atomic replacement or power-loss durability.

## Upgrade

Requires Obsidian 1.12.3+. Back up the existing plugin data before upgrading. Replace `main.js` and `manifest.json` with the files in `bettersync-0.5.8.zip`, then reload Obsidian. BetterSync verifies the new state file before removing embedded progress from `data.json`. Keep your database and recovery code; there is no server schema change. Do not downgrade by replacing only the plugin files: older builds do not understand the split state.

## Validation

TypeScript checks, 213 automated tests, and the production build passed locally. Tests cover interrupted writes, state integrity, and repeatable migration. Physical desktop, MacBook and iPhone acceptance remains open; this is a prerelease.
