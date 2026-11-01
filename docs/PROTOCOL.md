# Protocol and recovery

## Documents

One document per path:

```json
{"_id":"file:<base64url UTF-8 path>","_rev":"<server revision>","schema":1,"path":"Notes/Test.md","content":"text","mtime":0,"deleted":false}
```

Path identity is deterministic and case-preserving. Paths are never normalized from server input: traversal, backslashes, absolute paths, hidden components and non-Markdown paths are rejected. Invalid records are retained in local diagnostics while unrelated valid records continue.

A deletion writes `deleted: true, content: ""` using a normal revision-checked PUT. It does **not** set CouchDB `_deleted` and is never purged by BetterSync. A newly connected client can therefore learn a deletion even after compaction. A client that has already learned a deletion may intentionally create a new note at that path using the marker's revision.

The database must be exclusive to BetterSync's protocol. Direct administrative purges, native CouchDB tombstones and external replication branches are outside the supported topology. BetterSync clients use ordinary optimistic writes and never create independent CouchDB revision branches.

## Local state

Each installation stores a random identity, database binding, opaque changes checkpoint, a per-path last-accepted revision and SHA-256 digest (or null for deletion), and any pending incoming operations. The vault remains the source of local file contents; there is no embedded sync database. Pending incoming operations contain the remote note until the local operation is completed. Metadata is stored in Obsidian's local plugin data, which is never synchronized by BetterSync.

The baseline detects modifications or deletes made while the plugin was disabled or the app was closed. Startup inventories paths once; normal file events queue only the affected paths. Folder renames/deletions queue their tracked descendants.

## Serial cycle

1. Finish persisted incoming operations where possible.
2. Poll `_changes` with a saved, opaque checkpoint, up to 200 records per page.
3. Validate, journal and apply records. Failed filesystem work stays journaled, allowing later files/pages to proceed. Invalid records are quarantined in local diagnostics.
4. Save the checkpoint after the page is safely handled.
5. Upload dirty paths using the last-accepted revision as the write precondition.

A new local change during HTTP work remains queued. If a server write returns 409, refetch the note and apply conflict preservation; never blindly retry an overwrite with the fresh revision.

There is one running cycle per client. Periodic polls overlap neither themselves nor configuration changes. A network timeout returns control after 15 seconds. Obsidian's HTTP API has no portable abort facility: an underlying timed-out request may finish later. Its revision precondition and the next changes-feed pass make that safe, including accepted writes whose responses were lost.

## Incoming operation journal

Before writing the vault, save the remote document and the local baseline digest expected by that operation. On replay:

First persist the current incoming queue again. A failed save can leave an operation only in memory; subsequent polls must not apply it until persistence succeeds.

- If the local file already equals the desired remote contents, accept the baseline without rewriting.
- If it equals the expected baseline, apply the remote version.
- Otherwise preserve the local text in an ordinary conflict file, then apply the remote version.

Conflict copies have content-addressed names scoped to the installation, so replay finds the same contents rather than producing duplicates. If an existing conflict copy has been edited, create another distinct copy; never overwrite it.

Only after the filesystem operation is successful does the engine save the accepted baseline and remove the journal entry. Startup scanning also recovers conflict copies created immediately before a crash.

## Local writes and editing buffers

`Vault.process` guards replacement of existing text against a changed on-disk digest. The adapter checks every open source-mode editor for the note and defers remote replacement or deletion if any buffer differs from disk, until those changes are saved. Expected-write markers suppress normal reflected vault events; digest/baseline comparison makes duplicate or delayed events harmless.

Obsidian exposes no atomic compare-and-trash operation. Remote deletes recheck disk and open editing buffers immediately before `Vault.trash(file, false)`, which retains the deleted file in vault trash. A user edit in the final asynchronous deletion window is an outstanding real-device verification concern; trash is the recovery layer. This is a reason the implementation is not certified against the real-device no-data-loss acceptance gate yet.

Filesystem name equivalence differs between Linux, macOS and iOS. Case-only collisions and Unicode normalization collisions need testing on the target vaults. Invalid or unwriteable notes stay queued rather than authorizing an overwrite.

## Failure scope

Temporary network/server errors preserve all local files and retry on a later poll. Invalid credentials/database settings block repeated background retries until Retry or reconfiguration. A failed file stays in the persistent incoming queue, while unrelated files continue. Persisting metadata failures end the current cycle before a checkpoint can be accepted on disk.

A server's unavailability cannot prevent a user from editing the vault; only synchronization waits. iOS background suspension pauses the plugin itself, so background real-time sync is not promised.

## References

- [Obsidian Vault API](https://docs.obsidian.md/Plugins/Vault)
- [Obsidian mobile development](https://docs.obsidian.md/Plugins/Getting%20started/Mobile%20development)
- [CouchDB changes feed](https://docs.couchdb.org/en/stable/api/database/changes.html)
- [CouchDB document API](https://docs.couchdb.org/en/stable/api/document/common.html)
