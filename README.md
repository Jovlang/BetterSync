# BetterSync

Small Obsidian plugin for synchronizing Markdown notes through one self-hosted CouchDB database. Designed for desktop, laptop and phone, with no master client and no device registry.

**Status: implemented MVP candidate, not yet device-validated.** The automated suite exercises three independent sync engines, including offline edits, conflicts and restart recovery. The ten acceptance tests on real desktop, MacBook and iPhone clients remain the release gate. No actual Obsidian client was available in the build environment. A real CouchDB integration test subsequently passed in GitHub Actions.

## Install the test build

1. Use a disposable test vault and a dedicated, empty CouchDB database.
2. Copy `main.js` and `manifest.json` into `<vault>/.obsidian/plugins/bettersync/` on each device. Reload Obsidian and enable BetterSync under Community plugins. The Actions artifact contains these two files; create the `bettersync/` plugin folder yourself.
3. Enter the HTTPS server URL, database, username and password. Test the connection, then enable Sync.
4. On the device containing your notes, confirm **Upload**. Start the other devices with empty Markdown vaults and confirm **Download**.
5. Run [the three-device acceptance checklist](docs/ACCEPTANCE.md).

There is deliberately no first-time merge of two populated vaults. Canceling initial setup does not change either side. Retry can reopen the setup prompt. Resume after a confirmed setup is automatic.

On iPhone, place the plugin files in the vault's plugin folder using a Mac/PC or an iOS file-management method that can access `.obsidian`; do not copy another installation's `data.json`. Community-plugin installation from an archive is not an App Store installation.

## Daily use

Create, edit, delete or rename Markdown files normally. Sync runs roughly every three seconds while Obsidian is running. iOS can suspend the app in the background; sync resumes when the app returns to the foreground. Local editing works without the server.

A concurrent edit preserves the local text in a normal `*.sync-conflict-<client>-<content>.md` file and converges the main path to the server version. Conflict copies also sync to the other devices. They can be compared, edited or removed normally. Deletion against a newer edit keeps the newer remote note; an offline edit against a deletion becomes a conflict copy, leaving the original path deleted.

Only `.md` files are synchronized. Hidden paths, including `.obsidian`, are excluded. Attachments, Canvas, settings, plugins and themes stay local. Remote deletion uses the vault's local trash, never permanent filesystem deletion.

The normal states are **Synced**, **Syncing…**, **Offline**, **Conflict** and **Sync error**. Use **Retry** after fixing a connection problem. Connection errors stop automatic aggressive retries; temporary failures are retried. The Conflict indication stays visible for the current plugin session after a conflict occurs; conflict copies remain ordinary files after restart.

## Server requirements

Use a dedicated CouchDB 3.x database exposed through valid HTTPS, with a database user permitted to read and write notes. Create the database outside this plugin; BetterSync does not create databases, configure CouchDB, or change permissions. The URL can include a reverse-proxy subpath.

This protocol is independent of LiveSync: **do not point it at a LiveSync database** or run another sync engine against the same test vault. Ordinary CouchDB compaction is fine. Do not purge notes or remove BetterSync's deletion-marker documents: offline clients need those markers.

There is no end-to-end encryption. The server can read note contents, and credentials are stored in the installation's local Obsidian plugin data. Use a database-scoped account, protect the server, and do not commit or copy `data.json`.

## Development

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

The integration test expects an isolated test server with the test-only account defined in the workflow. It creates and removes its own timestamped database. It uses three real engine instances and real CouchDB HTTP, with simulated vaults. **That test passed in [GitHub Actions](https://github.com/Jovlang/BetterSync/actions/runs/41327984653).** It is separate from the manual Obsidian acceptance gate.

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
