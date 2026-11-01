# BetterSync

The user's Minimal Obsidian Sync specification is the project constitution. Read README.md and docs/SPEC.md before changing scope. Keep one sync model and a small normal UI. Do not add LiveSync compatibility, device registration, modes or algorithm settings.

Use Obsidian APIs and portable HTTP. No Node/Electron dependencies in plugin runtime code. Keep credentials and note content out of logs and commits.

For sync changes, run `npm run verify`; use three-client tests and exercise crash/offline cases. The real CouchDB wire test runs separately through `npm run test:integration` with an isolated test server. Never run it against a user's vault database.

Do not report MVP acceptance complete until all ten tests in docs/ACCEPTANCE.md pass on real desktop, MacBook and iPhone clients. Preserve that distinction in release notes.
