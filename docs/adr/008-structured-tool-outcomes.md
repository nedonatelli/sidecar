---
title: 'ADR-008: Structured tool outcomes instead of matching result text'
layout: docs
---

# ADR-008: Structured tool outcomes instead of matching result text

**Date**: 2026-11
**Status**: Accepted

## Context

A tool executor returns one string (`ToolExecutor` in `src/agent/tools/shared.ts`), and the executor wraps it into a `tool_result` block with an optional `is_error`. Whether a call changed a file is not recorded anywhere. Each part of the loop that needs to know works it out again, either from the result's wording or from the tool's name.

The places that do this today, on `main` at v0.135.0:

| Where                                                                                        | How it decides                                                      | Inferred edit | No-op edit  | Delete                                   | Failed edit |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------- | ----------- | ---------------------------------------- | ----------- |
| `countsAsFileMutation` (`loop/fileMutation.ts`)                                              | not an error and not "No change needed"                             | changed       | unchanged   | changed                                  | unchanged   |
| `MUTATION_OK_RE` (`loop/actionReprompt.ts`)                                                  | `File (edited\|written\|deleted): `                                 | **unchanged** | unchanged   | changed                                  | unchanged   |
| `isSuccessfulEdit` (`loop/circularRewrite.ts`)                                               | `File edited:` or `Applied inferred edit`                           | changed       | unchanged   | n/a (separate `File deleted:` check)     | unchanged   |
| `recordToolCall` (`completionGate.ts`)                                                       | tool name in `{write_file, edit_file}`, then not "No change needed" | changed       | unchanged   | **ignored**                              | unchanged   |
| `WROTE_FILE` (`tools/fs.ts`, stale-read guard)                                               | `File (edited\|written): ` or `Applied inferred edit to `           | changed       | unchanged   | n/a                                      | unchanged   |
| `deletedFiles` (`completionGate/reprompts.ts`)                                               | `File deleted: (\S+)`                                               | n/a           | n/a         | changed, **path cut at the first space** | n/a         |
| `MUTATION_TOOLS` in `cycleDetection.ts`, `unappliedEdit.ts`, `guards/regressionGuardHook.ts` | tool name only                                                      | changed       | **changed** | changed                                  | **changed** |

Each disagreement in bold has caused, or would cause, a wrong decision:

- #361: a no-op edit counted as a change, which switched off the action reprompt's "already done?" escape. Fixed in #378 by teaching one consumer the "No change needed" wording.
- #362: after an inferred edit the stale-read guard still trusted the model's earlier read, because it only knew the `File edited:` wording. Fixed in #379 the same way.
- The three name-only sets each list eight tools. `create_file` is an alias of `write_file`; `rename_file`, `move_file`, `apply_edit` and `apply_patch` are neither registered nor aliases. They also count a refused or failed edit as a change, so the regression guard's post-write trigger runs after an edit that changed nothing.
- An aliased call keeps the model's name in history (`str_replace` runs as `edit_file`), so every `tu.name === 'edit_file'` check misses it.
- In review mode the results read "Pending edit queued for review", which no text matcher knows. A queued edit counted as a change for `countsAsFileMutation` and the gate, and as no change everywhere else.

Each fix so far has made one more consumer match one more phrase. The wording is also a model-facing message that we change for model reasons (#161, #163, the outcome-visibility flag), and each such change can silently break a consumer. #162 and #163 both change what an edit's result says, so they would add more cases to this table.

The options:

- **Keep matching text, with one shared set of patterns.** Cheap, but the wording stays a control protocol: the model's message can't change without re-checking every consumer, and a path inside a sentence still has to be parsed back out.
- **Put the outcome on the `tool_result` block.** Simple to read, but the blocks are what gets sent to providers. `toAnthropicWire` rebuilds `tool_use` blocks field by field and passes `tool_result` blocks through unchanged, so every backend would have to strip the new field. A missed strip is a request error on a strict API.
- **Have the executor return the outcome next to the text, and keep it in loop state keyed by `tool_use_id`.** The model still gets the text, and the loop reads the outcome. Nothing new reaches a provider.

## Decision

File tools report a **structured outcome** next to their text, and every consumer that asks whether a call changed a file reads that outcome instead of the text or the tool name.

- **Shape.** `ToolOutcome = { kind: 'mutated' | 'noop' | 'failed'; paths: string[]; staged?: 'audit' | 'review' }`. `paths` are workspace-relative and forward-slashed (the repo's path rule). `staged` marks a write held in the audit buffer or the review store rather than on disk. Tools that never touch files report no outcome.
- **Producer.** Each exit of `write_file`, `edit_file` and `delete_file` that returns reports its outcome through `ToolExecutorContext.recordOutcome`, as does review mode's handler. `executeTool` installs that sink for every call (an aliased call resolves to a file tool inside it) and stores what was reported. A thrown error from a file tool becomes `{ kind: 'failed' }`. A file tool that returns without reporting is logged as a bug and records nothing. A sink rather than a `{ text, outcome }` return type, because `edit_file` delegates to itself (the inferred and insertion paths) and to `write_file` (an edit to a missing file): the nested call reports through the same sink, and the many callers and tests that read `editFile`'s string are unaffected.
- **Storage.** The loop keeps outcomes in `LoopState.toolOutcomes: Map<tool_use_id, ToolOutcome>`. Nothing is added to the message blocks, so provider serialization doesn't change. A history walk looks the outcome up by the block's `tool_use_id`. A block with no entry, from a resumed session or an MCP tool, reads as "no file change".
- **One predicate.** `changedFiles(outcome)` returns `paths` for `mutated` and an empty list otherwise. Every consumer that asks "did this change a file?" uses it. A staged write counts as a change. Audit mode behaves as before, since its "(buffered for audit review)" wording already matched. Review mode's queued edits now count in every consumer, not only two.
- **Attempts stay by name.** Cycle detection and the unapplied-edit nudge ask whether the model _called_ a file tool, not whether the call landed. Repeating a failing edit is the loop cycle detection exists to catch, and "you never applied it — use edit_file" is wrong after a failed `edit_file`, whose own error already says what to fix. Both resolve aliases through `fileToolName()`, and the four names that are neither tools nor aliases are dropped.
- **Aliases.** Every name check on a file tool goes through `fileToolName()`, which resolves the alias table.
- **The gate keeps deletes out.** Its per-file checks lint and test the edited file, and a deleted file has neither.
- **Text is for the model.** After the migration no loop or gate code reads the wording of a file tool's result. The text matchers are deleted in the same change, not kept as fallbacks.
- **Scope.** This covers file-changing tools only. Other text-as-protocol cases found in #367 stay as they are: the `[` prefix that marks injected messages, verification-result regexes, and MCP mutation tracking. Each needs its own decision.

This changes loop behaviour wherever a consumer disagreed with the outcome (the bold cells above). It ships with an agent eval, a `SCAFFOLD_VERSION` bump and a changelog entry, as any behaviour change does.

## Consequences

**Easier:**

- Consumers agree by construction, and a new consumer can't get it wrong by picking a different phrase.
- Model-facing result wording can change for model reasons (#161, #162, #163) without breaking a gate or a reprompt.
- The unregistered tool names leave the three name-only sets, and the regression guard no longer runs its post-write check after an edit that changed nothing.
- Trajectory analysis can record outcomes directly instead of re-deriving them from text (#390).

**Harder or accepted:**

- Every exit of the three file tools has to report. A new exit that forgets reads as "no change" and logs a warning. `toolOutcome.test.ts` covers each exit that exists today.
- The "already done" escape (`recentResultsShowWorkAlreadyDone`) still reads the "No change needed" wording. It asks whether the work is finished, not whether a file changed, and a `noop` outcome also covers an identical rewrite that is not "done".
- Outcomes live only for the run. A resumed session's earlier results read as "no file change". That is acceptable because the consumers that walk history stop at the user's latest message.
- The fixed disagreements change which nudges and gates fire. The agent eval has to show no regression, and the SWE canaries for #162/#163 run on top of this change, not before it.
