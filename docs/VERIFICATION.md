# Verification record — 1 November 2026

## Run in the build environment

- Node.js 24.22.1.
- `npm run check`: strict TypeScript check passes.
- `npm test`: 45 automated tests pass; no skipped tests.
- `npm run build`: bundled CommonJS Obsidian plugin builds successfully for browser/mobile runtimes.

Automated coverage includes three-client create/modify/rename/delete with each device as author; each client taking the stale offline role; simultaneous three-client creation; sequential edits without loops; server outage/recovery; client restarts; deletions while offline; delete/edit conflicts; intentional recreation after learned deletion; stale-write races; changes during HTTP and guarded local writes; lost write responses; interrupted incoming operations; failure of one file while later pages continue; invalid remote paths; opaque checkpoints; HTTP error classification; UTF-8 authentication and identity; timeout; initial setup/cancel/refusal; 1,050-note pagination; and four deterministic randomized edit/delete/restart schedules.

Tests use in-memory vaults and a revision-checking CouchDB model. They do not establish behavior of Obsidian's actual events, editor buffers, trash, filesystem naming rules or iOS suspension.

## Authored, not run here

`tests/couchdb.integration.ts` connects three engine instances to a real disposable CouchDB server. The GitHub Actions workflow provisions that server, runs the checks/build, runs the wire integration test, and uploads installable plugin files. This environment has no Docker/CouchDB runtime, so the real-server test was not executed here. CI execution and the real-server result are recorded separately in GitHub Actions.

## Outstanding release gates

All ten three-real-device acceptance scenarios in `ACCEPTANCE.md` remain NOT RUN. Desktop, MacBook, iPhone, a configured HTTPS CouchDB server, and their credentials were not available for those checks.

Known API limit: guarded deletion is a read followed by Obsidian's asynchronous vault-trash operation, not one atomic filesystem operation. The local trash retains deleted content, but the final edit-versus-trash race must be exercised on real clients. Case/Unicode equivalence across Linux/macOS/iOS also requires target-device checks.

## Repository

The user created the private `Jovlang/BetterSync` GitHub repository during implementation. The source, tests and build workflow are prepared for its `main` branch. See GitHub Actions for actual remote run results; an authored workflow is not itself evidence that CI passed.
