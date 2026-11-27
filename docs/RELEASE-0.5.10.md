# BetterSync 0.5.10 — Safer configuration startup

- BetterSync validates saved configuration before running setup or sync. It stops with a recovery notice if `data.json` is unreadable or invalid, or if it is missing while either local progress file still exists. It does not replace the configuration with defaults in those cases.
- Development instructions now protect the configuration, sync progress, and recovery files in live plugin installations from cleanup.

Requires Obsidian 1.12.3+. Replace only `main.js` and `manifest.json` with the files from `bettersync-0.5.10.zip`, then reload Obsidian. No reset or database change is required. Upgrades from 0.5.7 or earlier in the 0.5.x series still run the [local state migration introduced in 0.5.8](RELEASE-0.5.8.md).

This is a prerelease. Physical desktop, MacBook, and iPhone acceptance remains open. iPhone persistence performance and reload stress testing are not covered by this release.
