# Schema-4 initial materialization investigation

**A real-device intermittent initial-materialization stall was observed once on Mac. It has not yet been reproduced, and platform specificity is unproven.** Initial-sync acceptance remains blocked.

## Observed evidence

- One real Mac initial encrypted sync materialized 12 of 18 Markdown files before stalling.
- Six Markdown files, five SVGs and one JPG remained in the durable incoming journal while the UI stayed in Sync error for minutes.
- Manual Retry subsequently materialized all remaining entries. The original exception was not captured.
- The same encrypted dataset completed on a physical iPhone. This demonstrates that the dataset and general schema-4 paths can complete on a physical client; it does not establish a Mac-only defect or rule out an iPhone stall.
- Synthetic filesystem, interrupted-write, normal-poll recovery, restart recovery and isolated real-CouchDB integration tests pass. They have not reproduced the observed stall and do not replace real-device acceptance.

The pending journals establish receipt and durable retention of these records. Successful Retry establishes that their content could subsequently be fetched, authenticated and materialized. Neither identifies the original failing operation. The affected set includes Markdown and non-Markdown files; there is no evidence that extension or inline/attachment representation triggered the stall.

Platform specificity, determinism, recurrence on the same Mac, and the root cause are unknown. Engine state, filesystem behavior, Obsidian lifecycle and polling are investigation targets, not established causes. Do not call this a confirmed Mac runtime defect.

Read-only source inspection found 24 ordinary files and one directory, all represented in saved source baselines. There are 25 expected file/directory records plus a separate configuration record, which also uses schema 4. Clarify whether the reported server count excludes configuration. Source baselines are not an independent server inventory; full source/server/destination byte comparison remains outstanding.

## Repeated real-device attempts

Use a disposable acceptance database and a fresh destination test vault for each initial-download attempt, with the diagnostic build active. Keep the encrypted dataset fixed within a series and record build identity and platform/app versions. Never reset a personal vault or run the integration-test suite against an acceptance database. Do not delete the evidence from a stalled run before capturing it.

For each run record bounded observations only:

- completion or stall, records materialized, pending incoming count;
- incoming failure stage, fixed failure category, whitelisted filesystem error code if present;
- engine blocked, stopped and running-cycle flags;
- whether a poll was scheduled and whether its callback and a new cycle actually started;
- whether journal/state persistence completed after the failure;
- unattended observation duration, eventual recovery, and whether manual Retry was used.

Count files and directories separately. A saved baseline count is not by itself proof of filesystem materialization. Treat unavailable observations as UNCAPTURED, not false or successful. Ordinary diagnostics must not contain plaintext bodies, credentials, recovery material, raw exceptions or unbounded paths.

If a stall occurs:

1. Do not immediately click Retry. Capture read-only state first.
2. Verify pending journal envelopes against authenticated remote contents, including exact-revision attachment retrieval. Do not mutate journals, baselines or checkpoints during inspection.
3. Observe whether unattended polling and persistence progress; record the duration and outcome without assuming a scheduled timer actually fired.
4. Only then use Retry if needed, recording its outcome separately from automatic recovery.
5. Compare the complete supported source/destination tree and exact file bytes before declaring that attempt complete.

## Current diagnostic capabilities and gaps

The diagnostic build logs bounded incoming failure stages and categories, with only whitelisted filesystem error codes. It does not log raw errors, paths or payloads in those messages.

The read-only developer-console script in scripts/trace-encrypted-tree.js compares local entries with authenticated remote contents and reports engine flags and whether a timer handle exists. Its explicit tree report includes paths and sizes: review locally before sharing; do not use it as ordinary diagnostic logging. Run it on both source and destination and account for concurrent edits. It does not modify files, records, checkpoints or retry state.

A timer handle does not prove a poll fired. The current script does not capture poll-start history or persistence-completion history. Those observations must be captured through bounded instrumentation before a repeated-run series can support conclusions about automatic recovery. Current-state inspection after Retry cannot reconstruct the missing original exception.

## Run ledger and interpretation

| Attempt | Platform | Outcome | Materialized before stall | Pending files | Recovery | Original failure |
|---|---|---|---|---|---|---|
| Reported initial attempt | Mac | Stall observed | 12 of 18 Markdown files; directory count uncaptured | 12 (6 Markdown, 5 SVG, 1 JPG) | Manual Retry completed remaining entries | UNCAPTURED |
| Reported same-dataset attempt | iPhone | Completed | Not applicable | None reported on completion | No stall reported | Not applicable |

No subsequent fresh Mac attempts have been recorded in this investigation. Current evidence: **1 stall observed across 1 reported fresh real-Mac initial-sync attempt**. Append every subsequent attempt, including clean runs, and report the observed count as “1 stall observed across N fresh real-Mac initial-sync attempts” if no additional stalls occur. Do not infer a failure probability from a small sample.

Clean runs increase confidence but do not erase or explain the original event. Until explained, retain the classification intermittent/unreproduced regression. iPhone success lowers the priority of explanations requiring a universally broken dataset/protocol; it does not establish platform specificity.

## Acceptance and preservation

Keep initial-sync acceptance blocked until evidence supports either:

1. reproduction, root cause and a verified fix with regression coverage; or
2. repeated real-device runs and captured diagnostics providing sufficient confidence in automatic recovery, with the transient failure mode safely observable and recoverable.

Repeated clean runs alone do not establish the second outcome. Document the evidence and remaining uncertainty rather than choosing an arbitrary passing-run count.

Do not add speculative retry behavior or extension-specific handling. Preserve durable incoming journals: never advance an applied baseline or discard an unapplied operation. A feed checkpoint may advance only when each earlier record is applied or durably retained for replay under the existing journal contract; it must never cause an unapplied record to be skipped or lost.

An initial sync may encounter a transient failure, but it must never silently lose data or remain indefinitely stalled without either automatic recovery or a diagnosable error state.
