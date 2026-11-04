# BetterSync 0.3.0 — E2EE preview

This prerelease introduces end-to-end encrypted sync with recovery-code setup and Obsidian SecretStorage for keys and database passwords. Small files use authenticated inline ciphertext; larger files use encrypted attachments retrieved at the exact revision. Both representations use the existing conflict-preserving sync engine and durable incoming journals.

Small-file initial download no longer requires an attachment request per file. In a three-pair synthetic 20-note benchmark with 50 ms added request latency, median download was 244 ms encrypted versus 200 ms plaintext, with three requests for each. These are real CouchDB tests with simulated vaults, not device measurements.

## Install

Requires Obsidian **1.11.4 or later**. Use disposable test vaults and a dedicated empty CouchDB database exposed through HTTPS. Copy `main.js` and `manifest.json` from the release assets into `<vault>/.obsidian/plugins/bettersync/`, reload Obsidian and enable the plugin. The ZIP contains the same files plus licensing notices.

Set up encryption on the first client and save the recovery code outside the vault. Join from empty vaults on other clients using that code. Do not copy `data.json` between devices.

**Existing plaintext databases cannot be upgraded in place.** Create a fresh local test vault and database, then copy the files you intend to synchronize into the new vault. There is no plaintext fallback. Earlier provisional encrypted databases have no compatibility guarantee.

## Validation and limits

- 139 automated tests pass, including crypto interoperability, wrong-key/tamper/substitution rejection, three-client conflicts and crash/offline recovery. Both isolated real CouchDB integration tests pass.
- Schema 4 remains provisional; this release does not freeze the protocol or claim completed MVP acceptance.
- All ten acceptance scenarios still require real desktop, MacBook and iPhone validation. Physical-iPhone encrypted peak-memory testing remains a freeze/release gate for a stable release.
- Transfers are buffered. The provisional 200 MiB protocol limit is **not** a claim of encrypted iPhone support at that size.
- No independent cryptographic audit has been performed. Independent review is recommended, not an additional user-imposed freeze criterion.

See `docs/E2EE-DEVICE-CHECKLIST.md` for device testing, `docs/TRANSPORT-DECISION.md` for transport evidence and outstanding gates, and `docs/TESTING.md` for reproducible synthetic infrastructure. No workstation-specific infrastructure is required.
