# Draft encrypted build: device handoff

Status: NOT RUN on physical devices. Schema 4 remains provisional. Use disposable synthetic vaults and a dedicated HTTPS CouchDB database; never a personal vault. Do not reuse the loopback-only Compose test credentials on a reachable server.

## Reproduce and install

Run npm ci and npm run verify from a clean checkout using Node 22 or later. The generated main.js and tracked manifest.json are the installable files. Copy both into each vault's .obsidian/plugins/bettersync directory. Use Obsidian 1.11.4 or later; do not copy data.json between clients. Record the commit, file SHA-256 hashes, OS, Obsidian version, iPhone model and CouchDB version. A locally supplied ZIP is a draft test build, not a schema-stability or release claim.

## Setup and recovery

1. On desktop, configure the dedicated database, set up encryption, save the recovery code outside the vault, enable Sync and confirm upload of synthetic notes. On MacBook and iPhone, use empty vaults and the same code, then confirm download.
2. Try an incorrect recovery code on another disposable empty installation. It must refuse access without changing files. Cancel recovery-code setup; no key setup should be committed. Cancel the later transfer prompt; no notes should transfer (previously confirmed encryption configuration can remain).
3. Restart every client and reconnect after an outage. Restore the recovery code on a fresh installation. Verify exact note contents, binary hashes and empty directories.
4. Inspect plugin data and captured logs locally: no password, recovery code, root key or plaintext note content. Local paths and sync bookkeeping are expected; this is not local-vault encryption. Inspect CouchDB records: no plaintext paths, filenames, contents, mtimes, hashes or exact plaintext sizes. Never attach credentials, codes or personal records to an issue.

## Correctness and interruptions

Complete all ten scenarios in ACCEPTANCE.md. Repeat offline conflicts and app termination during upload, download and conflict preservation using synthetic files of 65,536 and 65,537 bytes, including extensionless files. Both contents must survive conflicts; restarts must resume without silent loss or stale resurrection. Test foreground return after iOS suspension. Keep all outcomes NOT RUN until observed.

## Physical iPhone performance and memory

Measure 20, 200 and 1,000 synthetic small-note initial downloads: time to first file, time to Synced, responsiveness and correctness. Record network conditions separately from results.

For encrypted upload and download separately, start with small files and increase through 1, 10, 25 and 50 MiB; attempt larger sizes only if earlier runs remain stable. Include interruption/restart and conflict recovery, where staging buffers may increase memory. Use an available physical-device process-memory profiler to record baseline and peak resident memory, profiler/tool version and sampling method. Record app termination or iOS memory-pressure events and whether recovery preserves all bytes. A desktop heap reading or simulator result is not iPhone peak-memory evidence. If profiling is unavailable, mark peak memory UNMEASURED rather than inferring it from successful transfers.

The 200 MiB bound is only a provisional protocol limit. Do not declare it supported on iPhone from a single successful operation. Report results without secrets; independent cryptographic review and all remaining freeze criteria still apply.
