# BetterSync 0.5.11 — Skip historical deletions at startup

BetterSync no longer checks previously deleted paths individually at startup when they are still absent locally and have no unfinished work. Their deletion markers and revision history are preserved. Files restored or newly deleted while BetterSync was off are still detected, and unfinished work is still queued.

Requires Obsidian 1.12.3+. Replace only `main.js` and `manifest.json` from `bettersync-0.5.11.zip`, then reload Obsidian. No reset or database change is required. Upgrades from 0.5.7 or earlier in the 0.5.x series still run the [local state migration introduced in 0.5.8](RELEASE-0.5.8.md).

This is a prerelease. Physical desktop, MacBook, and iPhone acceptance remains open.
