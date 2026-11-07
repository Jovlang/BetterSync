# Protocol and recovery

Historical pre-schema-5 protocol reference. Not a runtime compatibility mode. Current behavior is in [PROTOCOL.md](PROTOCOL.md).

## Documents

One document per path:

```json
{"_id":"file:<base64url UTF-8 path>","_rev":"<server revision>","schema":1,"path":"Notes/Test.md","content":"text","mtime":0,"deleted":false}
```

Path identity is deterministic and case-preserving. Paths are never normalized from server input: traversal, backslashes, absolute paths, `.obsidian` and `.trash` components are rejected. Invalid records are retained in local diagnostics while unrelated valid records continue.

Markdown retains schema 1 and UTF-8 text. Other regular files are written as schema 3 with a raw attachment named `content`, with no JSON `content` field. Existing schema 2 binary records remain readable as base64; no database migration is required. They are rewritten as schema 3 only on a later local upload. Directories use schema 2, a trailing slash in their record path, and content `directory`. The trailing slash is removed for filesystem access. A local file/directory replacement deletes the old record identity and creates the new one. Reading the old identity returns absent; its tombstone never removes the replacement type. Incoming creations wait for the previous object to be reconciled, including when records arrive in creation-before-deletion order. Concurrent incompatible live types stay queued rather than overwriting another object. The decoded file limit is 200 MiB. Empty directories are explicit records; deleting a directory waits for its children to reconcile and never recursively deletes local data.

All clients should be upgraded together: old clients cannot read the expanded protocol.

A deletion writes `deleted: true, content: ""` using a normal revision-checked PUT (schema 1 for Markdown, schema 2 otherwise). The marker omits `_attachments`, size and hash, removing the attachment from the new revision; historical attachment storage can be reclaimed by compaction. It does **not** set CouchDB `_deleted` and is never purged by BetterSync. A newly connected client can therefore learn a deletion even after compaction. A client that has already learned a deletion may intentionally create a new note at that path using the marker's revision.

The database must be exclusive to BetterSync's protocol. Direct administrative purges, native CouchDB tombstones and external replication branches are outside the supported topology. BetterSync clients use ordinary optimistic writes and never create independent CouchDB revision branches.

## Attachment transport

A live binary document has the following shape (CouchDB may add attachment digest and revision-position fields):

```json
{"_id":"file:aGVyby5qcGc","_rev":"2-example","schema":3,"path":"hero.jpg","mtime":1793660375593,"deleted":false,"size":4281932,"hash":"<64 lowercase hex SHA-256 of raw bytes>","_attachments":{"content":{"stub":true,"content_type":"application/octet-stream","length":4281932}}}
```

The size must be an integer from zero through 209,715,200 bytes. Schema 3 applies only to binary paths, requires the single named attachment, and rejects inline attachment data. Empty files use an attachment of length zero.

Uploads use a single `PUT /database/document-id` with `Content-Type: multipart/related`. The first part is JSON metadata carrying the expected `_rev` and `_attachments.content` with `follows: true`, content type and byte length. The second part contains the unencoded bytes. CouchDB commits metadata and attachment together in one new revision; there is no intermediate metadata-only document. A 409 enters the existing conflict-preservation path, never an overwrite retry against a refetched revision.

`_changes?include_docs=true&attachments=false` returns attachment stubs, not attachment data. CouchDB defaults `attachments` to false; BetterSync also specifies it explicitly. `_all_docs?include_docs=true` likewise returns stubs. Schema 1 text and legacy schema 2 base64 remain inline until those binary records are edited; the lightweight guarantee applies to schema 3 binary payloads.

## Transport and memory

The portable HTTP boundary supports string JSON or raw `ArrayBuffer` request bodies and explicit JSON or raw-buffer responses. The Obsidian adapter accesses `response.arrayBuffer` for attachments, without reading its JSON getter. Runtime code uses no Node, Electron, Blob/FormData transport, or base64 attachment encoding.

Obsidian `requestUrl` does not expose streaming requests/responses or portable cancellation. A multipart upload allocates one contiguous body in addition to the source file buffer: roughly twice the file size before native HTTP copies and other work. Downloads require a complete response buffer; local comparison, recovery and conflict preservation can also hold full file buffers. The adapter passes incoming raw buffers directly to binary staging writes instead of converting them to/from base64. Actual peak memory depends on Obsidian and platform internals, and may be considerably higher. Timed-out requests may remain alive and retain buffers until they finish. Near-limit iPhone transfers require real-device testing; the 200 MiB limit is a protocol bound, not a memory guarantee.

Schema 3 incoming journals store only metadata, so state cloning and saving no longer duplicate large binary payloads. Legacy schema 2 downloads/journals still incur base64 and decoding overhead. To preserve already-installed baseline digests and deterministic conflict filenames, local binary comparison retains SHA-256 of the historical base64 representation, computed incrementally in small chunks without allocating a full base64 string. The schema 3 wire hash is separately SHA-256 of raw bytes.

## Local state

Each installation stores a random identity, database binding, opaque changes checkpoint, a per-path last-accepted revision and SHA-256 digest (or null for deletion), and any pending incoming operations. The vault remains the source of local file contents; there is no embedded sync database. Pending incoming operations contain the remote document until the local operation is completed. For schema 3 this is metadata only, including the exact revision, expected raw SHA-256, decoded size and attachment stub; binary buffers are never serialized into plugin data. Existing pending schema 2 operations remain replayable. Metadata is stored in Obsidian's local plugin data, which is never synchronized by BetterSync.

Path dictionaries have null prototypes, restored whenever state is loaded or cloned into a new store. Filenames such as `constructor` and `__proto__` are ordinary own entries and survive JSON persistence.

The baseline detects modifications or deletes made while the plugin was disabled or the app was closed. Startup inventories paths once; normal file events queue only the affected paths. A portable stat inventory additionally discovers hidden entries and missed events. Folder renames/deletions queue their tracked descendants.

## Serial cycle

1. Finish persisted incoming operations where possible.
2. Poll `_changes` with a saved, opaque checkpoint, up to 200 records per page.
3. Validate, journal and apply records. Failed filesystem work stays journaled, allowing later files/pages to proceed. Invalid records are quarantined in local diagnostics.
4. Save the checkpoint after the page is safely handled.
5. Upload dirty paths using the last-accepted revision as the write precondition.

A new local change during HTTP work remains queued. If a server write returns 409, refetch the note and apply conflict preservation; never blindly retry an overwrite with the fresh revision.

There is one running cycle per client. Periodic polls overlap neither themselves nor configuration changes. A network timeout returns control after 15 seconds. Obsidian's HTTP API has no portable abort facility: an underlying timed-out request may finish later. Its revision precondition and the next changes-feed pass make that safe, including accepted writes whose responses were lost.

## Incoming operation journal

Before writing the vault, save the remote document and the local baseline digest expected by that operation. For schema 3, fetch `/database/document-id/content?rev=<journaled revision>` as raw bytes and verify both byte length and SHA-256 before any filesystem effects or baseline acceptance. A failed download or integrity check leaves the operation queued and the baseline unchanged. Retry re-fetches the exact revision; it never substitutes bytes from the latest revision. If compaction has removed an old queued revision, the operation remains pending until a later valid document from the changes feed supersedes it (or the server is repaired). Local contents and recovery bytes remain protected. On replay:

First persist the current incoming queue again. A failed save can leave an operation only in memory; subsequent polls must not apply it until persistence succeeds.

- If the local file already equals the desired remote contents, accept the baseline without rewriting.
- If it equals the expected baseline, apply the remote version.
- Otherwise preserve the local contents in an ordinary conflict file, then apply the remote version.

Conflict copies have content-addressed names scoped to the installation, so replay finds the same contents rather than producing duplicates. If an existing conflict copy has been edited, create another distinct copy; never overwrite it.

Only after the filesystem operation is successful does the engine save the accepted baseline and remove the journal entry. Startup scanning also recovers conflict copies created immediately before a crash.

## Local writes and editing buffers

`Vault.process` guards replacement of existing text against a changed on-disk digest. The adapter checks every open source-mode editor for the note and defers remote replacement or deletion if any buffer differs from disk, until those changes are saved. Expected-write markers suppress normal reflected vault events; digest/baseline comparison makes duplicate or delayed events harmless.

Obsidian exposes no atomic compare-and-trash operation. Remote deletes recheck disk and open editing buffers immediately before `Vault.trash(file, false)`, which retains the deleted file in vault trash. A user edit in the final asynchronous deletion window is an outstanding real-device verification concern; trash is the recovery layer. This is a reason the implementation is not certified against the real-device no-data-loss acceptance gate yet.

Filesystem name equivalence differs between Linux, macOS and iOS. Case-only collisions and Unicode normalization collisions need testing on the target vaults. Invalid or unwriteable notes stay queued rather than authorizing an overwrite.

Unindexed Markdown replacements use `DataAdapter.process` to check the digest inside an atomic text update. Binary replacements use the already-persisted incoming operation plus a recovery file at `.trash/bettersync/<SHA-256 of path>`:

1. Move the existing file into that recovery path, then verify the captured bytes. An edit between the initial read and the move is retained there and causes a retry.
2. Stage the desired bytes separately and install them using `DataAdapter.copy`, whose contract rejects an existing destination. A local file recreated during installation is therefore not overwritten.
3. Remove the recovery file only after installation succeeds. Before every incoming retry, including before accepting an already-matching file, inspect any recovery file. Preserve divergent bytes in a normal synced conflict copy, restore the original path if absent using a non-overwriting copy, and then clear recovery.

New unindexed files and conflict copies also use staged, non-overwriting copies. Staging files are removed in normal error/success cleanup; an abrupt process termination may leave disposable staging bytes in local `.trash`. Recovery files must remain until their incoming operations finish. This requires temporary disk space for the old file and staged incoming bytes. These portable API guarantees and behavior of external writers holding open file handles still require real-device validation, as does peak memory use near 200 MiB. Hidden-file and binary deletes retain contents in local trash. Directory deletes only remove empty directories.

## Failure scope

Temporary network/server errors preserve all local files and retry on a later poll. Invalid credentials/database settings block repeated background retries until Retry or reconfiguration. A failed file stays in the persistent incoming queue, while unrelated files continue. Persisting metadata failures end the current cycle before a checkpoint can be accepted on disk.

A server's unavailability cannot prevent a user from editing the vault; only synchronization waits. iOS background suspension pauses the plugin itself, so background real-time sync is not promised.

## References

- [Obsidian Vault API](https://docs.obsidian.md/Plugins/Vault)
- [Obsidian mobile development](https://docs.obsidian.md/Plugins/Getting%20started/Mobile%20development)
- [CouchDB changes feed](https://docs.couchdb.org/en/stable/api/database/changes.html)
- [CouchDB document API](https://docs.couchdb.org/en/stable/api/document/common.html)
- [CouchDB document-size configuration](https://docs.couchdb.org/en/stable/config/couchdb.html#couchdb/max_document_size)
- [CouchDB HTTP request-size configuration](https://docs.couchdb.org/en/stable/config/http.html#chttpd/max_http_request_size)
