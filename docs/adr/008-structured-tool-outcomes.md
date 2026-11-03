---
title: 'ADR-008: Structured tool outcomes instead of matching result text'
layout: docs
---

# ADR-008: Structured tool outcomes instead of matching result text

**Date**: 2026-11
**Status**: Proposed

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
- The three name-only sets each list eight tools, and five of them (`create_file`, `rename_file`, `move_file`, `apply_edit`, `apply_patch`) are not registered. They also count a refused or failed edit as a change: `applyUnappliedEditNudge` won't fire after a failed `edit_file`, which is exactly when the model's code block went unapplied.

Each fix so far has made one more consumer match one more phrase. The wording is also a model-facing message that we change for model reasons (#161, #163, the outcome-visibility flag), and each such change can silently break a consumer. #162 and #163 both change what an edit's result says, so they would add more cases to this table.

The options:

- **Keep matching text, with one shared set of patterns.** Cheap, but the wording stays a control protocol: the model's message can't change without re-checking every consumer, and a path inside a sentence still has to be parsed back out.
- **Put the outcome on the `tool_result` block.** Simple to read, but the blocks are what gets sent to providers. `toAnthropicWire` rebuilds `tool_use` blocks field by field and passes `tool_result` blocks through unchanged, so every backend would have to strip the new field. A missed strip is a request error on a strict API.
- **Have the executor return the outcome next to the text, and keep it in loop state keyed by `tool_use_id`.** The model still gets the text, and the loop reads the outcome. Nothing new reaches a provider.

## Decision

File tools report a **structured outcome** next to their text, and every consumer listed above reads that outcome instead of the text or the tool name.

- **Shape.** `ToolOutcome = { kind: 'mutated' | 'noop' | 'failed'; paths: string[]; staged?: 'audit' | 'review' }`. `paths` are workspace-relative and forward-slashed (the repo's path rule). `staged` marks a write held in the audit buffer or the review store rather than on disk. Tools that never touch files report no outcome.
- **Producer.** `ToolExecutor` may return `{ text, outcome }` as well as a plain string. `write_file`, `edit_file` (including the inferred-edit and replace-all paths) and `delete_file` return the structured form on every exit path. In `executor.ts`, a thrown error becomes `{ kind: 'failed' }` for the file tool that threw. A plain string from a file tool is a bug, and a test checks for it.
- **Storage.** The loop keeps outcomes in `LoopState.toolOutcomes: Map<tool_use_id, ToolOutcome>`. Nothing is added to the message blocks, so provider serialization doesn't change. A history walk looks the outcome up by the block's `tool_use_id`. A block with no entry, from a resumed session or an MCP tool, reads as "no file change".
- **One predicate.** `changedFiles(outcome)` returns `paths` for `mutated` and an empty list otherwise. Every consumer in the table uses it. A staged write counts as a change, as the "(buffered for audit review)" wording does today, so audit and review modes behave as before.
- **Text is for the model.** After the migration no loop or gate code reads the wording of a file tool's result. The text matchers are deleted in the same change, not kept as fallbacks.
- **Scope.** This covers file-changing tools only. Other text-as-protocol cases found in #367 stay as they are: the `[` prefix that marks injected messages, verification-result regexes, and MCP mutation tracking. Each needs its own decision.

This changes loop behaviour wherever a consumer disagreed with the outcome (the bold cells above). It ships with an agent eval, a `SCAFFOLD_VERSION` bump and a changelog entry, as any behaviour change does.

## Consequences

**Easier:**

- Consumers agree by construction, and a new consumer can't get it wrong by picking a different phrase.
- Model-facing result wording can change for model reasons (#161, #162, #163) without breaking a gate or a reprompt.
- The unregistered tool names leave the three name-only sets, and those sets no longer count a refused edit as a change.
- Trajectory analysis can record outcomes directly instead of re-deriving them from text (#390).

**Harder or accepted:**

- Every exit path of the three file tools has to return the structured form. `edit_file` has many such paths, so that's the bulk of the work and the main risk. The test that a file tool never returns a plain string covers this.
- Outcomes live only for the run. A resumed session's earlier results read as "no file change". That is acceptable because the consumers that walk history stop at the user's latest message.
- The fixed disagreements change which nudges and gates fire. The agent eval has to show no regression, and the SWE canaries for #162/#163 run on top of this change, not before it.
