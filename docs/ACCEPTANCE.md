# Real-device acceptance gate

**All rows are NOT RUN. A passing automated suite is not an MVP acceptance sign-off.**

Release is also **BLOCKED** by the observed iPhone freeze/restart loop after adding an approximately 88 MB MOV. Recovery safeguards and automated large-file coverage do not establish bounded-memory operation or iPhone acceptance. See [the large-attachment investigation](LARGE-ATTACHMENT-INVESTIGATION.md).

Schema-4 initial-sync acceptance is **BLOCKED** by one observed intermittent initial-materialization stall on Mac, not yet reproduced; platform specificity is unproven. Twelve of 18 Markdown files arrived before six Markdown files, five SVGs and one JPG remained incoming for minutes. Manual Retry completed the remaining entries. The same dataset completed on iPhone. The original exception was not captured. Full-tree byte equality and sufficient automatic-recovery evidence remain required. See [the investigation and repeated-run criteria](INITIAL-SYNC-INVESTIGATION.md). The numbered cross-device scenarios below remain unaccepted.

Use desktop (A), MacBook (B), and iPhone (C), all with the same build and a dedicated CouchDB database. Record Obsidian/plugin/OS versions and timestamps below. First initialize the populated test vault on A, then use empty vaults on B and C. Do not copy `data.json` between installations.

- Build commit: ____________________
- A OS / Obsidian: ____________________
- B OS / Obsidian: ____________________
- C iOS / Obsidian: ____________________
- CouchDB version: ____________________
- Tester / date: ____________________

| # | Scenario and steps | Required result | Actual result |
|---|---|---|---|
| 1 | A creates `test.md` containing distinctive text. | B and C receive the exact contents. | NOT RUN |
| 2 | B changes `test.md`. | A and C receive identical updated contents. | NOT RUN |
| 3 | C deletes `test.md`. | It disappears from A and B. No stale resurrection. | NOT RUN |
| 4 | A creates `old.md`, lets all clients sync, then renames it to `new.md`. | Old path disappears; new path and original contents appear on B/C. | NOT RUN |
| 5 | Disconnect B. A edits a note; confirm C receives it. Reconnect B. | B receives the change without reset or recovery. | NOT RUN |
| 6 | All clients share a note. Disconnect B. A edits; C receives A's version. B independently edits its old copy. Reconnect B. | Main file converges to A's version; B's version survives in an ordinary conflict note on all devices. Unrelated sync continues. | NOT RUN |
| 7 | A edits; await B/C. B edits; await A/C. C edits; await A/B. | Converges after each step, without unnecessary conflict copies. | NOT RUN |
| 8 | Stop CouchDB. Edit different notes on A and B. Restart CouchDB. | Local editing stays usable. All changes sync automatically after recovery. | NOT RUN |
| 9 | Restart all three Obsidian clients, including restarting iPhone. Include an unsynced local edit before shutdown. | Resumes automatically, preserves files and the pending edit, and shows no setup/recovery prompts. | NOT RUN |
| 10 | Restart CouchDB while all clients are running. | Temporary offline/error state, then automatic recovery with no user intervention. | NOT RUN |

Repeat the conflict scenario with A, B and C each taking the offline role. Confirm the same behavior on a fourth new, empty client if available.

## Additional checks before release

- [ ] Test connection from desktop and iPhone through the actual HTTPS reverse proxy.
- [ ] Upload confirmation, download confirmation and cancel produce the promised behavior.
- [ ] A populated client cannot ambiguously initialize against a populated server.
- [ ] Wrong credentials / missing database stop repeated retries and show understandable messages.
- [ ] Foreground return after iOS suspension catches up automatically.
- [ ] Edit the active note quickly while another device changes it; check pending editor buffers are preserved.
- [ ] Edit a note during a remote deletion; check contents, conflict copies and local trash. The Obsidian API lacks atomic compare-and-trash, so this is a known acceptance concern.
- [ ] Kill the app during incoming note writes, local upload and conflict-copy creation. Reopen and verify recovery.
- [ ] Unicode / spaces / nested folders / empty Markdown files work on all three filesystems.
- [ ] Check case-only and Unicode-normalization filename collisions do not overwrite contents silently.
- [ ] Rename and delete whole folders; descendant notes converge.
- [ ] Attachments and Canvas synchronize; plugin settings and the active configuration folder remain local.
- [ ] Thousands of notes remain usable and startup/polling have acceptable cost on iPhone.
- [ ] Do not ship as a completed MVP until the ten numbered rows and data-preservation checks pass.

## Expanded file scope checks

In addition to all ten original acceptance scenarios, test attachments, Canvas, extensionless and hidden files on all three real clients. Confirm `.obsidian` and recovery `.trash` stay local. Create, rename and remove empty and populated directories; ensure a remote directory deletion cannot remove unsynced children. Exercise binary conflicts, offline deletes, crash replay and file/directory collisions. Test files just below, exactly at and above 209,715,200 bytes with appropriately configured server/proxy limits. Verify concurrent binary edits during incoming writes and measure iPhone memory behavior near the limit. These checks are not yet device-validated.

- [ ] Use a custom Obsidian configuration folder; confirm settings and credentials never upload and remote records cannot modify that folder.
- [ ] Validate the declared minimum Obsidian version (1.11.4), or raise it before release.
