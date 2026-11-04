# BetterSync

Small Obsidian plugin for synchronizing vault files and directories through one self-hosted CouchDB database. Designed for desktop, laptop and phone, with no master client and no device registry.

**Status: 0.3.0 E2EE prerelease, not yet device-validated.** The automated suite exercises three independent sync engines, including offline edits, conflicts and restart recovery. The ten acceptance tests on real desktop, MacBook and iPhone clients remain the release gate. No actual Obsidian client was available in the build environment. A real CouchDB integration test subsequently passed in GitHub Actions.

## Install the test build

1. Use a disposable test vault and a dedicated, empty CouchDB database.
2. Copy `main.js` and `manifest.json` into `<vault>/.obsidian/plugins/bettersync/` on each device. Reload Obsidian and enable BetterSync under Community plugins. The Actions artifact contains these two files; create the `bettersync/` plugin folder yourself.
3. Use Obsidian 1.11.4 or later. Enter the HTTPS server URL, database, username and password. Test the connection, select **Set up encryption**, save the recovery code outside the vault, then enable Sync. On other devices, enter the same recovery code.
4. On the device containing your notes, confirm **Upload**. Start the other devices with empty vaults and confirm **Download**.
5. Run [the three-device acceptance checklist](docs/ACCEPTANCE.md).

There is deliberately no first-time merge of two populated vaults. Canceling the transfer confirmation does not transfer notes; an already confirmed encryption setup may have created the database configuration. Retry can reopen the setup prompt. Resume after a confirmed setup is automatic.

On iPhone, place the plugin files in the vault's plugin folder using a Mac/PC or an iOS file-management method that can access `.obsidian`; do not copy another installation's `data.json`. Community-plugin installation from an archive is not an App Store installation.

## Daily use

Create, edit, delete or rename files and directories normally. Sync runs roughly every three seconds while Obsidian is running. iOS can suspend the app in the background; sync resumes when the app returns to the foreground. Local editing works without the server.

A concurrent edit preserves the local text in a normal `*.sync-conflict-<client>-<content>.md` file and converges the main path to the server version. Conflict copies also sync to the other devices. They can be compared, edited or removed normally. Deletion against a newer edit keeps the newer remote note; an offline edit against a deletion becomes a conflict copy, leaving the original path deleted.

Regular files (including attachments, Canvas and hidden files) and directories (including empty ones) synchronize. The active Obsidian configuration folder (including custom `Vault.configDir` paths), `.obsidian`, and the local recovery directory `.trash` are excluded. The fixed per-file limit is 200 MiB (209,715,200 bytes); larger files stay local and report a sync error. Settings, plugins and themes inside `.obsidian` stay local. Remote deletion uses the vault's local trash, never permanent filesystem deletion.

The normal states are **Synced**, **Syncing…**, **Offline**, **Conflict** and **Sync error**. Use **Retry** after fixing a connection problem. Connection errors stop automatic aggressive retries; temporary failures are retried. The Conflict indication stays visible for the current plugin session after a conflict occurs; conflict copies remain ordinary files after restart.

## Server requirements

Use a dedicated CouchDB 3.x database exposed through valid HTTPS, with a database user permitted to read and write notes. The draft encrypted protocol stores files up to 64 KiB inline as authenticated ciphertext and larger files as encrypted attachments. Filenames, paths, modification times, hashes and exact plaintext sizes are encrypted. Configure request limits above the intended attachment size plus encryption and multipart overhead. Transfers are buffered, not streaming; source, ciphertext, multipart, native HTTP and recovery buffers can coexist. The 200 MiB protocol limit is not a promise that an encrypted transfer fits in iPhone memory. See [the transport decision and remaining gates](docs/TRANSPORT-DECISION.md). Create the database outside this plugin; BetterSync does not create databases, configure CouchDB, or change permissions. The URL can include a reverse-proxy subpath.

This protocol is independent of LiveSync: **do not point it at a LiveSync database** or run another sync engine against the same test vault. Ordinary CouchDB compaction is fine. Do not purge notes or remove BetterSync's deletion-marker documents: offline clients need those markers.

This development build enables draft end-to-end encryption after explicit setup. Recovery keys use Obsidian SecretStorage. Database passwords migrate to SecretStorage after verified write/readback; plugin data stores a secret reference. Use Show recovery code in settings to retrieve the vault key explicitly. Use a database-scoped account, protect the server, and do not commit or copy `data.json`.

E2EE implementation includes experimental crypto, recovery-code handling, resumable key setup, Obsidian secret-storage, encrypted CouchDB transport, and integration with the existing sync engine under automated tests. The draft encrypted path is connected to setup and startup. Existing plaintext installations are blocked and require a fresh local vault and database. The UI and lifecycle have not yet been validated inside real Obsidian clients. See [the implementation plan](docs/E2EE-PLAN.md) and [benchmark instructions](docs/E2EE-BENCHMARKS.md). The encrypted wire layout remains provisional pending small-file initial-sync and physical-iPhone memory measurements.

## Development

See [reproducible synthetic testing](docs/TESTING.md) for the self-contained disposable CouchDB configuration. No personal infrastructure is required.

Node.js 22+:

```sh
npm ci
npm run verify
```

This runs strict TypeScript checks, the automated tests and the browser-targeted build. The output `main.js` only imports Obsidian; runtime code uses neither Node nor Electron. `@noble/hashes` provides platform-independent SHA-256. There is no PouchDB or second local database.

GitHub Actions additionally starts a disposable CouchDB service and runs:

```sh
BETTERSYNC_TEST_SERVER=http://localhost:5984 npm run test:integration
```

The integration test expects an isolated test server with the test-only account defined in the workflow. It creates and removes its own timestamped database. It uses three real engine instances and real CouchDB HTTP, with simulated vaults. **The original protocol test passed in [GitHub Actions](https://github.com/Jovlang/BetterSync/actions/runs/41327984653).** The attachment-protocol wire test also passed locally against an isolated CouchDB 3.5 container on 3 November 2026, including restore and deletion after compaction. It is separate from the manual Obsidian acceptance gate.

## Source layout

- `main.ts`, `settings.ts`: lifecycle, tiny settings UI, connection test and initial confirmation.
- `sync-engine.ts`: one serial sync loop, event queue, conflict detection, retries and checkpointing.
- `couch-client.ts`: HTTP, authentication, revision preconditions and changes-feed validation.
- `vault-client.ts`: Obsidian APIs, parent directories, guarded writes and trash.
- `local-state.ts`: per-install identity, persisted baselines and serial saves.
- `conflict-handler.ts`: deterministic, non-overwriting conflict copies.
- `paths.ts`, `http.ts`, `types.ts`: path safety, hashing, request timeout and contracts.

See [the implementation contract](docs/SPEC.md), [protocol and crash handling](docs/PROTOCOL.md), [acceptance checklist](docs/ACCEPTANCE.md), and [verification record](docs/VERIFICATION.md).

## Repository and builds

Source: [Jovlang/BetterSync](https://github.com/Jovlang/BetterSync).

The GitHub Actions workflow builds an installable `bettersync-plugin` artifact containing `main.js` and `manifest.json`. Download it from a successful workflow run and place those files in the vault plugin folder described above.

## License

BetterSync is licensed under GPL-3.0-only. See [LICENSE](LICENSE). Bundled third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
