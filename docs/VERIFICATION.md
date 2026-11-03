# Verification record — 1 November 2026

## Run in the build environment

- Node.js 24.22.1.
- `npm run check`: strict TypeScript check passes.
- `npm test`: 45 automated tests pass; no skipped tests.
- `npm run build`: bundled CommonJS Obsidian plugin builds successfully for browser/mobile runtimes.

Automated coverage includes three-client create/modify/rename/delete with each device as author; each client taking the stale offline role; simultaneous three-client creation; sequential edits without loops; server outage/recovery; client restarts; deletions while offline; delete/edit conflicts; intentional recreation after learned deletion; stale-write races; changes during HTTP and guarded local writes; lost write responses; interrupted incoming operations; failure of one file while later pages continue; invalid remote paths; opaque checkpoints; HTTP error classification; UTF-8 authentication and identity; timeout; initial setup/cancel/refusal; 1,050-note pagination; and four deterministic randomized edit/delete/restart schedules.

Tests use in-memory vaults and a revision-checking CouchDB model. They do not establish behavior of Obsidian's actual events, editor buffers, trash, filesystem naming rules or iOS suspension.

## Passed in GitHub Actions

`tests/couchdb.integration.ts` connects three engine instances to a real disposable CouchDB server. The GitHub Actions workflow provisions that server, runs the checks/build, runs the wire integration test, and uploads installable plugin files. The original local build environment has no Docker/CouchDB runtime, so this test ran on GitHub's runner. [Verify run 41327984653](https://github.com/Jovlang/BetterSync/actions/runs/41327984653) completed successfully for commit `377fa67f9452c15d86b8f92be46dfc3019523d36`: clean dependency install, strict checks, all 45 tests, build, real CouchDB wire integration and artifact upload all passed. The `bettersync-plugin` artifact contains `main.js` and `manifest.json`.

## Safety fixes verified locally — 1 November 2026

`npm run verify` passes strict TypeScript checks, all 51 automated tests, and the browser-targeted plugin build. New three-client regressions cover failed journal persistence across repeated polls, recovery before filesystem effects, and restart replay for both replacement and deletion. Adapter tests exercise the real vault adapter with simulated Obsidian host classes, checking that unsaved contents in either of two panes defer replacement and deletion, then permit application once both buffers match disk.

The real CouchDB integration test was not rerun for these fixes. The user reports sync working across iPhone, Mac and Windows; the detailed ten-scenario acceptance checklist has not been recorded, and these fixes still need real-device verification.

## Outstanding release gates

All ten three-real-device acceptance scenarios in `ACCEPTANCE.md` remain NOT RUN. Desktop, MacBook, iPhone, a configured HTTPS CouchDB server, and their credentials were not available for those checks.

Known API limit: guarded deletion is a read followed by Obsidian's asynchronous vault-trash operation, not one atomic filesystem operation. The local trash retains deleted content, but the final edit-versus-trash race must be exercised on real clients. Case/Unicode equivalence across Linux/macOS/iOS also requires target-device checks.

## Repository

The user created the private `Jovlang/BetterSync` GitHub repository during implementation. The source, tests and build workflow are committed on its `main` branch. The successful run and installable artifact are linked above.

## Expanded file scope — 2 November 2026

`npm run verify` passes: strict TypeScript, 49 automated tests, and browser-targeted build. Added coverage includes binary byte preservation and chunk boundaries, non-Markdown and hidden files, explicit empty directories, three-client offline binary conflicts and restart recovery, binary incoming crash replay, portable adapter directory deletion guards, hidden-path discovery, and rejecting oversized files before reading contents. The CouchDB integration test now includes binary and empty-directory records, but was not run for this change: no isolated server or Docker is available in this session. The earlier CI pass applies to the earlier Markdown-only implementation.

All ten real desktop/MacBook/iPhone acceptance tests remain outstanding. Expanded-scope acceptance must additionally exercise near-limit file transfers, hidden paths, empty-directory rename/delete, type collisions, and binary edits during incoming writes. Binary adapter writes are guarded by a preceding digest check, but are not atomic; peak-memory behavior near 200 MiB remains unvalidated on iPhone. Upgrade all clients together before using the expanded protocol.

## Architecture review fixes — 2 November 2026

`npm run verify` passes strict TypeScript checks, all 66 automated tests, and the browser-targeted build. Added three-client regressions exercise file-to-directory and directory-to-file replacement across offline/restart boundaries; binary edits immediately before displacement and installation; crashes after displacement and installation; recovery even when the main file already matches the remote version; hidden Markdown edits during an atomic adapter update; concurrent creation at a binary destination; and prototype-named files through conflict, deletion, JSON reload and incoming-journal replay.

The adapter regressions execute the actual vault adapter against a simulated filesystem with file/directory constraints and Obsidian's documented non-overwriting `copy` contract. Binary replacement now retains displaced bytes in `.trash/bettersync` until installation/recovery completes; unindexed Markdown uses atomic `DataAdapter.process`. These changes supersede the unguarded binary-write limitation recorded in the expanded-scope entry above. Temporary disk space, external open-file writers, filesystem API guarantees on each platform and large-file memory use still require real-device testing.

The real CouchDB integration test was not run: no Docker executable or isolated `BETTERSYNC_TEST_SERVER` is configured in this session. All ten desktop/MacBook/iPhone acceptance scenarios remain outstanding; automated simulations do not establish MVP acceptance.

## Release preparation — 2 November 2026

With Node.js 24.19.0, `npm run verify` passed strict TypeScript checks, all 68 individual tests (none skipped), and the browser build. `BETTERSYNC_TEST_SERVER=http://127.0.0.1:15984 npm run test:integration` passed its real CouchDB three-client test against a disposable CouchDB 3.5 container. This supersedes the earlier local integration availability limitation. The container was removed after testing.

Added configuration-folder regression checks cover inventory exclusion and rejection of reads, creation, replacement/deletion and incoming recovery before filesystem access, including case variants. GPL-3.0-only licensing and the bundled MIT dependency notice are included. Real-device acceptance and verification of the declared minimum Obsidian version remain outstanding. No release has been published by this preparation step.

## Attachment protocol — 3 November 2026

The schema 3 transport uses atomic multipart uploads and revision-qualified raw attachment downloads. Local verification passes strict TypeScript, 81 automated tests (including three-client offline, binary conflict, path/type transition and crash-recovery cases), and the browser-targeted build. The real CouchDB wire suite passed locally against a disposable CouchDB 3.5 Docker container: upload (including empty and 9 MiB attachments), stub-only changes, raw download, clean restore, stale revision rejection, schema 2 upgrade, and attachment removal with deletion-marker discovery after compaction. No user vault database was used.

The ten real desktop/MacBook/iPhone acceptance scenarios remain outstanding. Buffered HTTP memory usage and mobile multipart transport have not been validated on actual Obsidian clients.

## E2EE foundation — 3 November 2026

`npm run verify` passes strict TypeScript, 92 tests (none skipped), and the browser-targeted plugin build. Eleven added tests cover independent Node HKDF/HMAC/AES-GCM interoperability, three independent crypto contexts, strict bounded parsing, Unicode/path identity, directory/deletion records, wrong keys/vaults, ciphertext tampering, attachment substitution and serialized envelope replay. The existing three-client crash/offline engine suite still exercises the current plaintext runtime; these new codec tests do not establish encrypted engine recovery.

Separately bundled `src/encrypted-protocol.ts` for the browser with esbuild: no external imports. Ran 20- and 100-note codec smoke benchmarks; scope, commands and aggregate results are in `E2EE-BENCHMARKS.md`. No real CouchDB integration run was needed for this increment because it adds no HTTP or engine path; the encrypted wire test is not implemented yet. Physical-iPhone memory, comparative initial-sync latency, secret storage, security review and all ten real-device acceptance scenarios remain outstanding. The active plugin does not yet encrypt transfers.
