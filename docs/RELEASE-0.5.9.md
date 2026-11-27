# BetterSync 0.5.9 — Clearer sync activity

- **Checking** means BetterSync is comparing a local path with its saved baseline. Startup checks for already-deleted files no longer appear as uploads or create upload history.
- **Upload** means BetterSync is sending content. **Send deletion** means it is sending a new deletion, not the deleted file.

Requires Obsidian 1.12.3+. Replace `main.js` and `manifest.json` with the files from `bettersync-0.5.9.zip` and reload Obsidian. No reset or database change is needed. Upgrading directly from 0.5.7 or earlier in the 0.5.x series still runs the [local state migration introduced in 0.5.8](RELEASE-0.5.8.md).

Physical desktop, MacBook and iPhone acceptance remains open; this is a prerelease.
