# BetterSync 0.4.0 — attachment recovery preview

This prerelease adds safeguards against repeated attachment failures making Obsidian unusable after restart. It remains a development E2EE preview, not an MVP acceptance release.

## Changes

- Persist attachment attempt markers before file reads and major processing stages. An interrupted transfer pauses on restart; repeated processing failures also pause the affected attachment while unrelated files continue syncing.
- Preserve pending work and local files. Explicit Retry resumes paused transfers; foreground and connectivity events cannot bypass the pause. Ordinary offline failures recover automatically.
- Queue file events without concurrent whole-file reads, yield during binary hashing, and prevent duplicate native HTTP requests while an earlier request remains unresolved after timeout.
- Add durable stage/size diagnostics and regression coverage for large encrypted attachments, interruption, restart, deletion, reconnect, integrity and lost acknowledgements.

## Known release blockers

The observed iPhone freeze/restart after adding an approximately 88 MB MOV is **not resolved or device-validated**. The 64 KiB hybrid threshold is an inline cutoff, not streaming chunk transport. Whole plaintext, ciphertext and multipart buffers can still coexist. Bounded-memory transfer remains unfinished; the exact iOS termination stage is unconfirmed.

The schema-4 E2EE format and 200 MiB per-file limit are unchanged. That limit is not demonstrated mobile capacity. The prior intermittent initial-download stall also remains an acceptance blocker. All ten real desktop, MacBook and iPhone acceptance tests remain unaccepted; automated tests do not replace them.

See [the investigation](https://github.com/Jovlang/BetterSync/blob/0.4.0/docs/LARGE-ATTACHMENT-INVESTIGATION.md) and [acceptance checklist](https://github.com/Jovlang/BetterSync/blob/0.4.0/docs/ACCEPTANCE.md).

## Validation

- TypeScript checks, 149 automated tests and the browser-targeted build passed.
- Four integration tests passed against isolated CouchDB 3.5 in WSL Docker, including an actual 88 MiB encrypted multipart upload with lost acknowledgement and exact size/SHA-256 verification.
- Three simulated clients cover encrypted large-file restart recovery and unrelated sync. Physical-iPhone memory and stability remain unverified.

## Install

Use a disposable test vault and dedicated encrypted CouchDB database. Install `main.js` and `manifest.json` in `<vault>/.obsidian/plugins/bettersync/`, then reload Obsidian. The ZIP contains those same two files. Requires Obsidian 1.11.4 or later. Do not copy another installation's `data.json` or point BetterSync at a LiveSync database.
