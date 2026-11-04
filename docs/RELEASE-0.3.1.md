# BetterSync 0.3.1 E2EE preview

BetterSync records the source modification time when uploading a file and restores the stored time when writing the file on another device. This applies to Markdown and binary files, including during initial download. Existing revisions uploaded by older builds contain the upload time. Directory timestamps are outside this change.

The automated suite covers fresh encrypted downloads and interrupted-write recovery, comparing file bytes and modification times. The intermittent initial-download stall observed on Mac remains under investigation. Schema 4 remains provisional, and the ten real-device acceptance scenarios remain open. See [the acceptance checklist](ACCEPTANCE.md).
