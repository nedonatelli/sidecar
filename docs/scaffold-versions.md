---
title: Scaffold Versions
layout: docs
nav_order: 16
---

# Scaffold Versions — the tracked registry

The **scaffold** is SideCar's harness around the model: the verification stack
(completion gate, critic, regression guards), the gates (impact, numerical,
analytic-bound), the guards (keep-best ratchet, injection guard), and the
tool-call repair. A benchmark number (BFCL, SWE-bench resolve/lift) is only
meaningful if you know **which scaffold produced it** — the scaffold evolves,
and a `scaffold-on = 14%` from one version isn't comparable to another's unless
the versions (and the active-mechanism snapshot) match.

This doc is the human-facing registry. The machine-readable source of truth is
[`src/agent/scaffoldVersion.ts`](https://github.com/nedonatelli/sidecar/blob/main/src/agent/scaffoldVersion.ts) (`SCAFFOLD_VERSION`

- `describeScaffold`), stamped into every `run.manifest.json` and every ablation
  report.

## Versioning scheme (semver)

The version captures the **implementation** behind the mechanism flags;
`describeScaffold` captures **which flags were on**. **Two runs are comparable
iff both match.**

| Bump              | When                                                                                                                                      | Comparability                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **MAJOR** `X.0.0` | A mechanism is added/removed, or its verification **semantics** change (new gate, changed gate/repair logic, changed do-no-harm behavior) | Cross-MAJOR results are **not** directly comparable  |
| **MINOR** `x.Y.0` | A new mechanism ships behind a flag (default OFF), or a default arm composition changes                                                   | Comparable when the active-mechanism snapshots match |
| **PATCH** `x.y.Z` | Tuning _within_ a mechanism (a threshold, a reprompt string) — no change to which mechanisms run                                          | Comparable; note the patch when reporting            |

**Discipline:** the PR that changes a scaffold mechanism bumps `SCAFFOLD_VERSION`
and adds a section here and to the changelog in `scaffoldVersion.ts`; a release
notes the bumps it ships in `CHANGELOG.md`. Leaving it to release time let
5.1.2 cover a week of changes (see 5.1.3). What counts is listed in
[AGENTS.md](https://github.com/nedonatelli/sidecar/blob/main/AGENTS.md#scaffold-version).

## Registry

### 7.0.23 — a commit SideCar couldn't check is held for approval (2026-11)

PATCH: no mechanism in the scaffold descriptor is added, removed or
re-defaulted. Comparable with 7.0.22, noting the patch.

- **What changed:** before a commit, SideCar runs git to see what the commit
  would hold. When one of those git calls failed or timed out inside the
  repository, the review returned no concerns and the commit went ahead
  unchecked. It now holds the commit for approval, saying the check couldn't
  run, and keeps any concern found before the failure. Outside a repository it
  still returns nothing, leaving the commit to fail by itself.
- **Eval impact:** none expected. SWE and agent-eval runs don't commit.
- **Measured:** no eval. Unit test: a damaged index inside a repository now
  holds the commit, and a force-add concern found before the failure is kept.

### 7.0.22 — scratch cleanup moves only scratch this run made (2026-11)

PATCH: no mechanism in the scaffold descriptor is added, removed or
re-defaulted. Comparable with 7.0.21, noting the patch.

- **What changed:** `scaffolding.scratchCleanup` moves a file only if it is
  new on disk and this run made it: a `write_file` or `edit_file` outcome
  names it, or one of the run's `run_command` commands contains its name. The
  name rules are narrower: script extensions only; `repro`, `reproduce`,
  `scratch` and `test_(repro|issue|fix|bug)` anywhere; `verify`, `debug`,
  `check`, `compare` and `test` only in the workspace root, and only where the
  root has no such file already; never under a test directory. The bare
  root-script rule is gone (#418).
- **Eval impact:** a scratch test file written under a test directory now
  stays in the patch.
- **Measured:** gemma4:31b SWE canary on the 24 #387 tasks, seed 11, vs main.
  Cleanup fired in 15/24 runs on main and 13/24 here. Patches carrying
  scratch 0/24 → 3/24, exactly the three test-directory files now kept
  (pre-registered: up to 5/24). Resolve 10 vs 11, one discordant pair that
  split at volatile tool output; 19/24 patches byte-identical.

### 7.0.21 — a link whose target doesn't exist is judged by that target (2026-11)

PATCH: no mechanism in the scaffold descriptor is added, removed or
re-defaulted. Comparable with 7.0.20, noting the patch.

- **What changed:** the check that keeps file tools inside the workspace
  follows links to where they really lead. A link whose target doesn't exist
  couldn't be followed, so it was judged as a new file at the link's own
  path. It is now judged by the path it points to, and a chain of links that
  never ends is refused.
- **Eval impact:** none expected. SWE and agent-eval tasks contain no such
  links.
- **Measured:** no eval. Unit tests: a broken link out of the workspace is
  refused, one pointing inside resolves to its target, and (where links can
  be created) a write through a file link to a missing file outside is
  refused.

### 7.0.20 — Ollama's thinking switch reaches Ollama; the per-model list is removed (2026-11)

PATCH: no mechanism in the scaffold descriptor is added, removed or
re-defaulted. Comparable with 7.0.19, noting the patch.

- **What changed:** Ollama chat requests put `think: false` inside `options`,
  which Ollama doesn't read, so neither `sidecar.ollama.disableThinking` nor
  the problematic-thinking model list (qwen3 8B/14B/32B, GLM-4.7-Flash,
  Laguna XS.2) ever turned thinking off on the chat path (#469). `think` is now
  a top-level field, sent only when the user turns thinking off, from the
  setting or the new chat header switch. The list is removed: it had no
  measurement behind it, and it never took effect.
- **Eval impact:** the default eval models send the same requests. The eval
  backend's one-shot `complete()`, used by the prompt eval and the retrieval
  judge, always asked for thinking off the same broken way; it now gets it, so
  those numbers can move for thinking models. Baseline provenance now records
  thinking on for the formerly listed models.
- **Measured:** no eval. Pre-registered live check: one request each way to a
  formerly listed model, confirming Ollama returns `message.thinking` without
  `think` and none with top-level `think: false`.

### 7.0.19 — image prompts run with their text; autonomy answers only approvals (2026-11)

PATCH: no mechanism is added, removed or re-defaulted. Comparable with 7.0.18,
noting the patch.

- **What changed:** A prompt with images ran with empty text, so retrieval,
  skill matching and message framing saw nothing; it now runs with its text,
  and keeps its images on regenerate and Reconnect (#419). Switching to
  autonomous mode answers "Allow" only on cards that offer it. Clarifying
  questions, checkpoints, diff previews and irrecoverable-operation reconfirms
  stay pending, where before each got "Allow" as its answer.
- **Measured:** no eval. The evals send no images and never switch modes during
  a run.

### 7.0.18 — graph-expanded retrieval hits use 1-based lines (2026-11)

PATCH: no mechanism is added, removed or re-defaulted. Comparable with 7.0.17,
noting the patch.

- **What changed:** Graph-expanded caller and callee hits, in system-prompt
  retrieval and `project_knowledge_search`, used the analyzers' 0-based rows as
  1-based: each body started a line early and lost its last line, and a call on
  a function's last line was never attributed (#426). The summarizer's timeout,
  and Stop, now cancel its request. The fallback workspace context (used while
  the index is not ready) is passed verbatim: a section filter that never
  filtered, and joined the line before every `### ` heading, is removed.
- **Measured:** no eval. Neither eval harness attaches a symbol graph to the
  tool runtime or calls `injectSystemContext`, so no eval reaches this code.

### 7.0.17 — integration tool results (2026-11)

PATCH: no mechanism is added, removed or re-defaulted. Comparable with 7.0.16,
noting the patch.

- **What changed:** `mutation_test` in a shadow workspace or fork runs its tests
  there; it ran them on the main tree, so every mutant survived. GitHub check
  runs and PR review comments are read past the first page of 100. The
  dependency check asks OSV about the version an npm lockfile installed, not
  the floor of the range. Custom tools get the Windows system variables they
  need to start (#427).
- **Measured:** no eval. The SWE and agent evals use none of these tools.

### 7.0.16 — auto-fix reads which files a call changed (2026-11)

PATCH: no mechanism is added, removed or re-defaulted. Comparable with 7.0.15,
noting the patch.

- **What changed:** The auto-fix pass took the files to diagnose from
  `write_file` and `edit_file` calls by name and input path. It now reads each
  call's outcome (ADR-008), as the stub check and circular-rewrite guard do: a
  refused or no-op edit no longer spends an auto-fix retry, an aliased
  `str_replace` is checked, and a deleted file is skipped.
- **Measured:** no eval. Auto-fix (`sidecar.autoFixOnFailure`) is off by
  default, and only the ablation arms turn it on; compare ablation runs either
  side of this version on the autoFix arm by commit.

### 7.0.15 — inferred edits keep line endings and bracket balance (2026-11)

PATCH: no mechanism is added, removed or re-defaulted. Comparable with 7.0.14,
noting the patch.

- **What changed:** When `edit_file` infers the region to replace (#163), the
  region in a CRLF file no longer ends in the last line's `\r`, which left a
  bare LF (ML-34). The not-found path now applies the delimiter-balance check
  the missing-search path already did; for a file with no grammar, such as
  HTML, it is the only structural guard (ML-46). Region scoring is one sliding
  pass instead of a rescan of every window, with identical results: a 730-line
  replace on a 3,824-line file went from 46.7 s to 9 ms (ML-33).
- **Measured:** no eval. Inferred writes to CRLF and no-grammar files are rare,
  and ML-33 changes only running time; 3,000 random snippets from 1,160 repo
  files gave identical output under the old and new scoring.

### 7.0.14 — edit_file failures are described more accurately (2026-11)

PATCH: no mechanism is added, removed or re-defaulted. Comparable with 7.0.13,
noting the patch.

- **What changed:** The stub check reads only calls that changed a file (from
  the call's outcome, ADR-008), and skips a placeholder restated from that
  edit's `search` (#161 ML-08). A multi-line `within` written with LF resolves
  in a CRLF file (ML-31). A search that occurs only above its `within` is
  reported as such, with the lines, instead of "search string not found"
  (ML-74).
- **Measured:** e4b SWE canary, 50 tasks × seeds 11/22/33, against 7.0.2
  (`4fff5877`). Resolve 20/150 in both arms, with no discordant pair; stub
  reprompts 5 → 0. Of four P2P differences, three trace to volatile tool output
  (test timing, memory addresses). The fourth, sphinx-7686 seed 22, came from a
  stale-read change that was taken out; re-run without it, the task matched the
  base event for event. ML-07, in earlier versions of this change, cost 2
  resolves and 7 repeat P2P regressions on two canaries and was taken out
  first.

### 7.0.13 — DuckDB and Postgres schema tools read real rows (2026-11)

PATCH: no mechanism is added, removed or re-defaulted. Comparable with 7.0.12,
noting the patch.

- **What changed:** On DuckDB, `db_query`, `db_list_tables` and
  `db_describe_table` read the driver's rows as objects, but it returns arrays:
  column names and values did not line up, and table and column names came back
  undefined. Primary keys are now detected. Row counts use the table's schema on
  DuckDB and Postgres; Postgres looked in a schema named after the database.
- **Measured:** no eval; the database tools are offered only when database
  profiles are configured, and no eval configures one.

### 7.0.12 — switch_backend no longer offers Kickstand (2026-11)

PATCH: no mechanism is added, removed or re-defaulted. Comparable with 7.0.11,
noting the patch.

- **What changed:** `switch_backend`'s description, `profile` enum and enum
  description drop the unreleased Kickstand profile.
- **Measured:** no eval; the evals send `switch_backend` as a one-sentence stub,
  which is unchanged.

### 7.0.11 — Anthropic cache tokens count toward the context estimate (2026-11)

PATCH: no mechanism is added, removed or re-defaulted. Comparable with 7.0.10,
noting the patch.

- **What changed:** Compression anchors on the last turn's input tokens.
  Anthropic's `inputTokens` leaves out the cached prefix, so with prompt caching
  a long chat never compressed. The anchor now adds `cacheCreationInputTokens`
  and `cacheReadInputTokens`, which other backends report as 0. A pinned
  `sidecar.ollama.numCtx` / `SIDECAR_OLLAMA_NUM_CTX` also sets the context
  budget.
- **Measured:** no eval; the eval harness runs on Ollama, which reports no cache
  tokens, and no eval script pins `SIDECAR_OLLAMA_NUM_CTX`.

### 7.0.10 — db_execute reports the rows a write changed (2026-11)

PATCH: no mechanism is added, removed or re-defaulted. Comparable with 7.0.9,
noting the patch.

- **What changed:** `db_execute` reported "Rows affected" from the rows
  returned, and asked for none, so every write read as 0 and a model could send
  an INSERT again. The count now comes from the driver, or reads `unknown`, and
  `RETURNING` rows render. In Audit Mode the result says the statement did not
  run, and the tool description says it is not executed there.
- **Measured:** no eval; the database tools are offered only when database
  profiles are configured, and no eval configures one.

### 7.0.9 — review mode queues delete_file (2026-11)

PATCH: no mechanism is added, removed or re-defaulted. Comparable with 7.0.8,
noting the patch.

- **What changed:** In review mode `delete_file` is queued for review like a
  write, with no prompt, and until it is accepted reads and searches treat the
  file as gone.
- **Measured:** no eval; review mode is not used in the evals.

### 7.0.8 — mutation_test and db_migrate_up follow the command rules (2026-11)

PATCH: no mechanism is added, removed or re-defaulted. Comparable with 7.0.7,
noting the patch.

- **What changed:** `mutation_test`'s `test_command` and `db_migrate_up`'s
  custom command get the checks `run_command` gets (deny and ask rules,
  destructive-command and install confirmation), and the file `mutation_test`
  mutates gets `write_file`'s path checks.
- **Measured:** no eval; neither tool is used in the SWE or agent evals.

### 7.0.7 — untrusted-content markers stay intact (2026-11)

PATCH: no mechanism is added, removed or re-defaulted. Comparable with 7.0.6,
noting the patch.

- **What changed:** Marker text inside untrusted content is made inert, so a
  marked block runs to its end and already-marked-looking text is still checked.
- **Measured:** no eval; the eval repos contain no marker text.

### 7.0.6 — git_diff leaves credential files out (2026-11)

PATCH: no mechanism is added, removed or re-defaulted. Comparable with 7.0.5,
noting the patch.

- **What changed:** `git_diff` names a changed credential file without showing
  its lines, as `grep` and `read_file` already do.
- **Measured:** no eval; SWE-bench repos have no such files.

### 7.0.5 — install approval reads each package manager's flags (2026-11)

PATCH: no mechanism is added, removed or re-defaulted. Comparable with 7.0.4,
noting the patch.

- **What changed:** The install approval parses flags per package manager, so a
  short flag that takes a value for one tool no longer hides the package after
  it, and versioned `pip3.11 install` is recognized.
- **Measured:** no eval; it changes only which installs are asked about, and the
  evals auto-approve.

### 7.0.4 — type-to-confirm covers more destructive commands (2026-11)

PATCH: no mechanism is added, removed or re-defaulted. Comparable with 7.0.3,
noting the patch.

- **What changed:** The destructive-command confirmation recognizes Windows and
  PowerShell recursive deletes, `find -delete` under a path, whole-tree `git
checkout`/`git restore`, and more `rm -rf` and force-push spellings, including
  inside `bash -c`. A plain `rm -f file` no longer asks as if recursive.
- **Measured:** no eval; the evals auto-approve, so the confirmation never shows
  there.

### 7.0.3 — every tool call gets its own id within a chat (2026-11)

PATCH: no mechanism is added, removed or re-defaulted; the checks that read
tool outcomes now read the right ones. Comparable with 7.0.2, noting the patch,
except for reprompt and ratchet counts (see Measured).

- **What changed:** native Ollama numbered its tool calls from `ollama_tc_0` on
  every request, and the text-form parsers did the same with `text_tc_N` and
  `stream_tc_N`. `state.toolOutcomes` (7.0.0, ADR-008) is keyed by that id, so a
  call that recorded no outcome inherited the entry an earlier call left: a
  `read_file` after an edit counted as a file change. A repeated id is now
  renamed `<id>-2`, `-3` and so on, seeded from the ids already in the chat
  (#417).
- **Measured:** e4b SWE canary, 50 tasks × seeds 11/22/33, against 7.0.2.
  Non-file calls reading a stale "mutated" outcome fell from 437 (in 135 of 150
  runs) to 0. Outcomes equal: F2P progress 20% vs 19% (0 fixed, 2 broke,
  p = 0.50), resolve 20 vs 19, P2P regressions 3 fixed and 3 broke. Injected
  reprompts fell from 163 to 136 and ratchet armings from 19 to 9, so those
  counts from 7.0.0–7.0.2 runs include the phantom changes.

### 7.0.2 — edit_file refuses fewer edits that were fine (2026-11)

PATCH: tuning within `edit_file`'s definition guards; no mechanism is added,
removed or re-defaulted. Comparable with 7.0.1, noting the patch.

- **What changed:** the dropped-definition guard reads a definition line that
  gains a return type or a nested decorator call as still present, and no
  longer reads prose that starts with a keyword as a definition (#162 ML-42).
  An empty `replace` over a definition's whole block, or a lone decorator,
  applies (ML-43). The shadow-definition guard runs on Python and JS/TS files
  only and skips lines inside a Python triple-quoted string (ML-44); a
  reassignment that reads its own prior value is allowed, and when the added
  line comes last the refusal names the earlier line as the dead one (ML-70).
- **Measured:** bundled with 7.0.1 in the same SWE canary (see 7.0.1):
  outcomes equal. These guards fired rarely in it: "drops the line" refusals
  13 vs 9, shadow-definition refusals 2 vs 2, over 150 runs per arm.

### 7.0.1 — escalate only a repeated call; decline a wrong inferred write (2026-11)

PATCH: tuning within `edit_file` and the tool-error suffix; no mechanism is
added, removed or re-defaulted. Comparable with 7.0.0, noting the patch.

- **What changed:** the "N consecutive … rejected for the same reason" streak
  keys on a hash of the call's arguments, so only a resubmitted identical call
  escalates (#161 ML-72). When `search` is not found, the inferred APPLY tier
  declines, and the suggest tier quotes the region instead, when the region
  stops short of `replace`, sits at a different indentation, or lacks the
  literal `\n` escapes of a one-line `replace` (#163 ML-20). An applied
  inferred edit records tier `inferred` and the syntax guard's verdict in
  `edit_outcome` (ML-71).
- **Measured:** SWE canary, gemma4:e4b, 50 tasks × seeds 11/22/33, against a
  7.0.0 control, bundled with 7.0.2. F2P progress 20% = 20%, resolve 13% =
  13%, P2P regress 20% vs 18%. Localize 59% vs 55% (0 fixed, 6 broke,
  p = 0.031): three pairs diverge on volatile tool output, three on this
  change dropping a false "2nd consecutive" suffix; none changed F2P.
  Escalation suffixes after a call with different arguments went from 217
  to 0. The inferred APPLY tier was reached once in 300 runs (django-15902 seed
  22): the control wrote the misindented, duplicated line, and 7.0.1 declined
  it. `tier: inferred` was not exercised.

### 7.0.0 — structured tool outcomes (2026-11)

MAJOR: the triggers of the completion gate, the action reprompt and the
regression guard change. Not directly comparable with 6.0.x.

- **What changed:** `write_file`, `edit_file` and `delete_file` report what
  each call did to the workspace — `mutated`, `noop` or `failed`, plus
  `staged` for audit-buffer and review-store writes — and every check that
  asks "did this call change a file?" reads that report instead of matching
  the result's wording (#367,
  [ADR-008](adr/008-structured-tool-outcomes.md)). An inferred edit counts as
  a change everywhere; a failed or no-op edit no longer runs a `post-write`
  regression guard; a queued review-mode edit counts as a change everywhere;
  an aliased call (`str_replace`, `create_file`, `rm`) is treated as the tool
  it runs as; an identical rewrite is a `noop`.
- **Measured:** agent eval ×3 against a 6.0.2 control on the same base.
  gemma4:31b 241 vs 240/243. ministral-3 ran twice: 214 vs 222/243, then,
  with the arms in the opposite order, 218 vs 219/243. No case dropped in
  both runs; each run's leads (−2 per case) were different cases, and the
  first run's four traced to sampling (identical prompts, catalog and first
  gate nudge in both arms). The A/B ran before 6.0.3 merged; 7.0.0 includes
  it, and the two were not measured together.

### 6.0.3 — a missing checker is a final answer (2026-11)

PATCH: tool-result wording within existing tools (run_command, run_tests); no
mechanism is added, removed or re-defaulted. Comparable with 6.0.2, noting the
patch.

- **What changed:** when a checker (`tsc`, `eslint`, `jest`, `ts-node`, `mypy`
  and similar) can't run because it isn't installed — npm's placeholder `tsc`,
  npx fetching a checker the project doesn't have, the shell not finding it —
  run_command's result says that is final: don't create a project, install a
  toolchain or write config to make it run; use `get_diagnostics` and say the
  change is unverified beyond it. run_tests recommends `npx tsc --noEmit` only
  where TypeScript is installed, and its no-runner answers now forbid building
  a runner (a test script, framework config, a framework install) rather than
  writing a test file (#279).
- **Measured:** agent eval ×3, ministral-3 and gemma4:31b against a 6.0.2
  control. The full suite is equal on the cases both share (ministral 218/243
  both, gemma 238 vs 240/243). On the new `no-toolchain-bootstrap` case, re-run
  per trial with no global toolchain and an empty npm cache, all 12 runs pass
  and none installs anything; in the two gemma runs per arm that tried
  `npx ts-node`, 6.0.2 retried with ts-node and tsx (4 `run_command` calls
  each), 6.0.3 got the note and stopped after one. `toolchain-setup-on-request`
  passes 3/3 in every arm.

### 6.0.2 — web-tree-sitter 0.25 (2026-11)

PATCH: no mechanism is added, removed or re-defaulted; the parser runtime under
the existing ones changes. Comparable with 6.0.1, noting the patch.

- **What changed:** web-tree-sitter 0.24.7 → 0.25.10. The edit-time syntax
  check, the symbol graph and the tools built on it parse with the new
  runtime. The Dart grammar (language ABI 15, which 0.24 could not load) now
  loads, so Dart symbols come from tree-sitter instead of the regex fallback.
  Dart is still not syntax-checked (the grammar misparses 33 of 226 files from
  six published packages), and bash is still disabled (its scanner throws on
  0.25 too) (#400).
- **Measured:** not A/B'd. The parsing, syntax-check and symbol-indexer suites
  pass unchanged on 0.25, and so does the integration suite (from source).
  Three installed-VSIX smoke runs load 18 grammars (Dart included) and build
  the same 7,824-symbol graph each time, with no event-loop stalls.

### 6.0.1 — cmd-style `nul` redirects in Git Bash (2026-11)

PATCH: input handling of an existing tool (run_command); no mechanism is added,
removed or re-defaulted. Comparable with 6.0.0 except on Windows runs where a
model writes a `nul` redirect.

- **What changed:** models write cmd's `2>nul` out of habit. In Git Bash, which
  run_command uses on Windows, `nul` is not the null device: bash creates a
  real file named `nul`, which Explorer and `git clean` cannot delete. When the
  shell is a POSIX shell on Windows, unquoted redirect targets of `nul`
  (`>nul`, `2>nul`, `>>nul`, `&>nul`, `<nul`, any case) now go to `/dev/null`.
  Quoted text, `null`, `nul.txt` and heredoc delimiters are unchanged. The SWE
  harness also deletes any path `git clean` reports it could not remove before
  retrying, so a leftover file can't stop later tasks (#395).
- **Measured:** not A/B'd; behavior changes only when a model writes a `nul`
  redirect. One of 57 runs did in the nemotron-3-super run that found it.

### 6.0.0 — scratch cleanup, on by default (2026-11)

MAJOR: a mechanism is added to the default scaffold, as
`sidecar.scaffolding.scratchCleanup` (default on). Results from 5.x are not
directly comparable on patch contents; turning the setting off reproduces 5.1.21.

- **What changed:** models that reproduce a bug before fixing it leave
  `reproduce_issue.py`, `verify_fix.py` and the like behind, mostly written
  through the shell. The loop records the untracked files at run start; at the
  end of a run that wasn't stopped, each file the run created that has a
  scratch name (or is a script in the workspace root) and that no other file in
  the change refers to moves to `.sidecar/scratchpad/<run id>/`. That folder
  carries its own `.gitignore`, so the moved files stay out of git status and
  the SWE patch. A file the user's message names is kept, as is an
  ordinary-named new file in a test directory. Without git, only files
  write_file created are known. Off in audit mode. In the SWE eval it is on in
  `scaffold-on` and off in `scaffold-off`; `SIDECAR_SWE_SCRATCH_CLEANUP=1` or
  `=0` forces it in every arm. A run that hits the per-task timeout is aborted,
  so it is not cleaned up.
- **Measured (2026-11-01):** gemma4:31b SWE A/B, 24 canary tasks whose archived
  31b patches most often carried scratch, seed 11, same commit, setting off vs
  on. Patches carrying scratch files 15/24 → 2/24 (13 pairs lost it, 0 gained
  it; exact McNemar p ≈ 0.0002); scratch files in patches 23 → 5; new files
  that are not scratch 6 → 6; median patch 2,044 → 1,151 bytes. Resolved 11 vs
  11, the same tasks. Both leftovers were per-task timeouts. 31b agent eval
  with the setting on: 240/243 trials against 239/243 at release 0.134.0; the
  one failing case (`large-file-vague-semantics`, 0/3) was 0–1/3 at the last
  four releases, and the one cleanup it made (a `test_version.ts` the agent
  wrote) was in a case that passed 3/3.

### 5.1.21 — run_tests reads a test target sent under another name (2026-10)

PATCH: input handling of an existing tool; no mechanism is added, removed or
re-defaulted. 5.1.20 is #385.

- **What changed:** in 14,947 archived trajectories, `run_tests` was called
  with the target as `path` 506 times against 114 as `file`; about 750 calls
  in 344 runs sent the target under a key the tool doesn't declare, which it
  dropped silently and ran the whole suite (40 of those ran over 2 minutes).
  `path`, `test_file`, `test_path`, `module`, `test_module`, `label` and
  `test_label` are now read as `file`, with a note in the result; any other
  unknown key is named as ignored; a call with no `command`, no `file` and only
  unknown keys throws, so it is an error rather than a suite run the completion
  gate would count. The gate resolves the target the same way (#386).
- **Measured:** e4b SWE canary, main `74bf3743` vs this change, 50 tasks ×
  3 seeds: NULL on every outcome, with no discordant pair on the primary or
  on resolve (F2P progress 18% → 18%, resolve 11% → 11%, P2P regressions
  23% → 23%). A target sent under another name was read in 6 runs and in
  none of the base arm's; nothing was ignored or refused. In one pair the
  base run sent `label` five times, ran the whole Django suite each time and
  hit the 600 s task timeout; this arm ran the named tests and finished in
  158 s.

### 5.1.20 — a search-only run_command spends grep's budget (2026-10)

PATCH: calls are re-keyed to an existing budget; no mechanism is added and no
budget size changes.

- **What changed:** a `run_command` whose every `&&`, `||`, `;` or `|` segment
  is a read-only search (`grep`, `rg`, `find`, `ls`, `cat`, `head`, `tail`,
  `wc`, `sed -n`, ...) or a `cd`, with no redirect, `tee`, `find -exec/-delete`
  or `sed -i`, now counts against `grep`'s budget instead of `run_command`'s.
  Its refusal says the call counted as a search. Cycle detection's refused-repeat
  pass keys calls the same way.
- **Why (#311):** on gemma4:31b, 21% of SWE runs spent the whole `run_command`
  budget, about half of it on searches, and 16% of runs ended with the last
  edit never tested. Of 2,538 archived 31b `run_command` calls, 30% are
  search-only.
- **Measured:** gemma4:31b SWE A/B against main `74bf3743` on a targeted
  subset (16 tasks at seed 11, plus the 7 that always exhaust at seed 22):
  NULL on resolve (12/23 in both arms, discordant pairs 1–1). Refusals moved
  from run_command (42 → 12) to grep (0 → 28); sampled refused commands
  that would have run code went 9 → 2. No timeouts in either arm, no harm.

### 5.1.19 — repeated budget refusals escalate, and refused repeats stop (2026-10)

PATCH: the text of an existing refusal and a pass inside existing cycle
detection; no mechanism is added, removed or re-defaulted.

- **What changed:** of 351 archived canary runs that hit a tool budget, 274
  (78%) called the refused tool again, about 5 refusals each. From the second
  refusal of a tool on, the message now says the call didn't run and further
  calls will be refused the same way, and names offered tools with budget left
  that can stand in for it (or says to give a final answer). In cycle
  detection, a turn whose every call goes to a spent budget, after one of those
  tools was refused 3 times, gets the #222 one-time nudge if no edit has
  landed, and otherwise stops the run.
- **Measured:** bundle canary with #358, #378 and #379 against main
  `cec4ce23`: agent eval ministral-3 215/243 in both arms, gemma4:e4b
  233 → 236; e4b SWE canary, 50 tasks × 3 seeds, NULL on the primary (F2P
  progress 19% → 19%, resolve 12% → 12%), runs ending on the cap 3% → 1%. Two
  runs first diverged at this change. The canary disables cycle detection, so
  it measures only the message. gemma4:31b agent eval, main `71570fae` vs this
  branch, 3 trials: 240/243 in both arms, no case changed; no budget refusal
  repeated in either arm.

### 5.1.18 — an inferred edit marks its file as written since the last read (2026-10)

PATCH: what an existing guard recognizes; no mechanism is added, removed or
re-defaulted.

- **What changed:** the stale-read guard marked a file as written since its
  last read only when the result said `File edited:` or `File written:`. An
  inferred edit reports "Applied inferred edit to …" instead, so after one
  landed the guard still treated the model's earlier read as current. It now
  recognizes the inferred-edit summary too.
- **Measured:** bundle canary with #358, #350 and #378 against main
  `cec4ce23`. Agent eval: ministral-3 215/243 in both arms, gemma4:e4b
  233 → 236. e4b SWE canary, 50 tasks × 3 seeds: NULL on the primary (F2P
  progress 19% → 19%, resolve 12% → 12%). One inferred edit occurred, in both
  arms, and no run first diverged at this change.

### 5.1.17 — a "No change needed" edit is not a file mutation (2026-10)

PATCH: what an existing counter counts; no mechanism is added, removed or
re-defaulted.

- **What changed:** the loop counted every `edit_file`, `write_file` or
  `delete_file` result that wasn't an error as a file mutation. "No change
  needed" (search equal to replace, or the file already holding the content)
  isn't an error, so a run that had changed nothing switched off the action
  reprompt's "already done?" escape and the read-only cycle nudge as if it had
  changed a file. It no longer counts, alone or after a tolerance note.
- **Measured:** bundle canary with #358, #350 and #379 against main
  `cec4ce23`. Agent eval: ministral-3 215/243 in both arms, gemma4:e4b
  233 → 236. e4b SWE canary, 50 tasks × 3 seeds: NULL on the primary (F2P
  progress 19% → 19%, resolve 12% → 12%). "No change needed" results came up
  5–10 times per cell, but no run first diverged at this change.

### 5.1.16 — a command that did not run is a tool error (2026-10)

PATCH: the error flag and text of an existing tool's result; no mechanism is
added, removed or re-defaulted.

- **What changed:** `run_command` and `run_tests` returned "command not found"
  (exit 127) as an ordinary result ending in `(exit code: 127)`, so the model
  was told the call succeeded; the shell's own failures came back as
  `Command failed: …` the same way. Exit 127 (not found), 126 (not executable)
  and 9009 (cmd.exe: not recognized), and a failed shell, are now tool errors
  carrying the shell's message, the exit code and a note naming the program —
  for Python: try `py` or `python3`, or the project's virtualenv. Every other
  non-zero exit (failing tests, grep with no match) is unchanged.
- **Measured:** bundle canary with #350, #378 and #379 against main
  `cec4ce23`. Agent eval: ministral-3 215/243 in both arms, gemma4:e4b
  233 → 236. e4b SWE canary, 50 tasks × 3 seeds: NULL on the primary (F2P
  progress 19% → 19%, resolve 12% → 12%). The note fired in 5 results and
  2 runs first diverged at it, neither changing outcome. On one Windows
  workstation without Python in Git Bash the case was 56 results across 28
  SWE runs, every one `isError: false` before this change.

### 5.1.15 — the eol match note names the search's own line ending (2026-10)

PATCH: the text of an existing note; no mechanism is added, removed or
re-defaulted.

- **What changed:** after an edit matched only by ignoring line endings, the
  note told the model which line ending its search used. It read that from
  the replacement after the replacement had been converted to the file's line
  ending, so an LF search on a CRLF file was told "your search used CRLF line
  endings", which describes no difference at all. Of 3,909 eol-tier notes
  recorded, 3,794 were wrong this way. The note now names the search's own
  line ending, and the trailing-space note also says when a multi-line
  search's line endings differed.
- **Measured:** e4b SWE canary, 50 tasks × 3 seeds against main `dde0c504`:
  NULL on the primary (F2P progress 20% → 19%, resolve 13% → 12%, McNemar
  p = 0.50). The note changes text the model sees in many edits: 82 of 150
  runs first diverge at it. Both lost resolves were seaborn-3010 (seeds 11 and
  22). On 10 further seeds that task resolved 10/10 in both arms, so the
  losses were how those seeds played out.

### 5.1.14 — the commit check asks about ignored files themselves (2026-10)

PATCH: two more conditions on the 5.1.9 commit approval; no mechanism is
added, removed or re-defaulted.

- **What changed:** 5.1.9 asked about _copies_ of ignored files, but not about
  a commit holding a path `.gitignore` itself matches. `git add` refuses such a
  path unless forced, so these were staged with `git add -f` or were tracked
  before the rule existed (git keeps tracking them). The check now runs
  `git check-ignore --no-index` over everything the commit would hold and asks
  about either kind, and asks about a command that force-adds, whose files are
  not staged yet when it looks.
- **Measured:** not run through an eval; no eval case commits ignored files.
  An ordinary source change passes every check.
- **Number:** 5.1.11 was held for this change while it was open; it merged
  after 5.1.13, so 5.1.11 is skipped.

### 5.1.13 — gate nudges don't reset the reprompt's window (2026-10)

PATCH: a narrower trigger on an existing mechanism; nothing is added, removed
or re-defaulted.

- **What changed:** the action reprompt is skipped when a change has landed,
  or a read request was answered, since the user's message. It took any
  user-role text not starting with `[` as the user's message, so each
  completion-gate nudge restarted the window and a finished run was
  re-prompted for not calling tools. A text-only user message now counts only
  when its text is part of the request or a steer. No-file-write no longer
  asks for a file the run deleted.
- **Measured (bundle night, with #350):** agent eval reprompt firings 45→13
  on gemma4:e4b and 52→25 on ministral-3, pass rate 235→233 and 214→222 of 243. e4b SWE canary, 150 pairs: firings 88→35, F2P 20%→20%, resolve
  13%→13%, no task changed.

### 5.1.12 — git_push goes where its approval says (2026-10)

PATCH: a new optional parameter and a description change on an existing tool;
no mechanism is added, removed or re-defaulted.

- **What changed:** `git_push` pushed to `origin` whatever the branch tracked,
  and `setUpstream` did not set an upstream. It now pushes to the branch's
  upstream remote, or to a `remote` the call names, falling back to `origin`;
  `setUpstream` pushes with `-u`. The approval for `git_push`, and for a
  `git push` run through `run_command`, shows the remote's URL, whether the
  GitHub repository is public, the target branch (and whether it is new), and
  the commits and diffstat that would go up.
- **Measured:** not run through an eval: no eval case pushes.

### 5.1.10 — grep without grep on PATH (2026-10)

PATCH: an existing tool's executable lookup and error text; no mechanism is
added, removed or re-defaulted.

- **What changed:** the `grep` tool ran `grep` from PATH. Git for Windows'
  default PATH setting adds only its `cmd` folder, so a machine with git and
  Git Bash could still have no `grep` for the tool to start. Every call then
  failed with ENOENT, reported as "Grep failed" with a regex hint, or — for a
  path-shaped pattern, or the relaxed search of a pasted snippet — as "No
  matches found", a false absence. On Windows the tool now uses the
  `usr/bin/grep.exe` beside the git on PATH, then the standard install
  folders. With no grep anywhere it is a tool error that says nothing was
  searched and points at `git grep`.
- **Measured:** not run through an eval; the eval machine has grep on PATH.
  On one Windows workstation 114 of 120 grep calls failed this way.

### 5.1.9 — a commit is looked at before it is made (2026-10)

PATCH: a new approval condition on existing tools; no mechanism is removed or
re-defaulted. 5.1.6–5.1.8 were held for PRs still open when this merged,
and are skipped.

- **What changed:** nothing looked at what a commit held. In one autonomous
  run the agent copied two gitignored folders (its own `.sidecar/logs` and
  `.sidecar/cache`) into a tracked folder and committed 757 files, 70.7 MB,
  then pushed them. `.gitignore` matches paths, so the copy was an ordinary
  new file. `git_commit` and a shell `git commit` now ask first, in every
  mode, when the commit would add copies of gitignored files (same content;
  dependency folders excluded), exceed 10 MB in total or 5 MB in one file,
  add more than 500 files, or hold a path over 200 characters. Declined, or
  with no one to ask, the agent is told not to commit them another way or
  push.
- **Measured:** not run through an eval; no eval case commits files like
  these. An ordinary source change passes every check.

### 5.1.5 — unrequested project-config changes need approval (2026-10)

PATCH: a new approval guard on the existing write tools and `run_command`; no
mechanism is added, removed or re-defaulted.

- **What changed:** edits, writes and deletes of package manifests and
  compiler, lint, test-runner and Python config, plus shell commands that
  rewrite them (`npm init`, `npm pkg set`, `tsc --init`, `sed -i`, redirects),
  need approval in every mode when the user's request names neither the file
  nor that kind of change. A declined or unanswerable change tells the agent to
  finish without it and say what it would need. Sub-agents judge against the
  user's request. (#351)
- **Measured:** agent eval, 3 trials per case, against the release-0133
  baselines. ministral-3 215/237 and gemma4:31b 233/237 on the shared cases
  (215 and 235); the gemma −2 is on large-file cases the guard never touched.
  The two new cases that ask for config changes: strict mode 3/3 on both,
  test script 3/3 on gemma and 1/3 on ministral (both misses are the model's
  own script). 8 unrequested config edits were declined; none was needed.

### 5.1.4 — an edit written out as a fake tool result runs (2026-10)

PATCH: a new recovery shape inside existing text-form tool-call recovery,
behind the same `codeAsTextRecoveryEnabled` flag. Models that call tools
natively are unaffected.

- **What changed:** text-form callers sometimes write an `edit_file` call and
  an invented result into the reply instead of calling the tool. When a turn
  parses no text-form calls, an `edit_file` or `write_file` call whose
  arguments sit in a `<tool_output tool="…">` block is salvaged and run
  through every normal guard and approval. Salvaged calls carry the
  `fake_output_` ID prefix. (#342)
- **Measured:** agent eval, 79 cases × 3 trials. qwen2.5-coder:7b 142 → 147/237,
  with the salvage firing in 11 trials (9 passed). ministral-3 213/237 and
  gemma4:31b 236/237 against 215 and 235 baselines, with no salvage firing.

### 5.1.3 — catch-up for fixes merged without a bump (2026-10)

PATCH: each change tunes a firing condition or a message inside an existing
mechanism; none adds, removes or re-defaults one. These merged between
2026-10-22 and 2026-10-28 while the version stayed at 5.1.2, so **a manifest
stamped 5.1.2 from after 2026-10-21 may include any of them — compare those
runs by commit, not by version.**

- **Completion gate:** package installs are not test or checker runs (#282);
  a test script that runs no test earns no test credit (#283); no read/write
  demands for files the request only quotes, or that don't exist (#325).
- **Reprompts:** no "no tool calls detected" to a model that finished (#285);
  check a reprinted "already done" when nothing changed (#303); a question or
  a "do not change" request is not a change request (#331).
- **Loop counting:** a shell command that edits a tracked file counts as an
  edit (#286); only applied edits count against edit_file's budget (#329).
- **edit_file:** a search == replace no-op is diagnosed correctly on CRLF
  files (#330); an edit that removes an import the file still uses is refused
  (#336); the dropped-definition refusal fires only where the edit would
  write, so a non-matching edit gets "search string not found" (#343).
- **Tool-call parsing:** every call in a multi-object fence is dispatched and
  calls quoted in prose are skipped (#301); a `<tool_call>` body's end is found
  with a string-aware scan (#333).
- **grep:** the pattern goes on stdin so quotes work on Windows, and an invalid
  regex is searched literally (#322).

### 5.1.2 — iteration ceiling by tier (2026-10)

PATCH: a threshold within an existing mechanism. Medium and weak are
unchanged.

- **Strong tier defaults to 150 iterations** (`maxIterations: 150` in
  `ScaffoldingProfile`) when neither the caller nor the user sets a ceiling.
  Medium and weak keep 50. On the 50-task SWE canary, claude-haiku-4-5 hit
  the 50-iteration ceiling on 32 of 50 tasks and resolved 25/50; at 150 it
  resolved 30/50, tying Claude Code, with no run reaching 150. (#237)
- **What wins over the tier default:** an explicit `sidecar.agentMaxIterations`
  (including an explicit 50), a skill's own `maxIterations`, and the SWE
  harness's `SIDECAR_SWE_MAX_ITERS` (default 50). `sidecar.scaffolding.overrides.maxIterations`
  pins the tier default itself.
- The setting's maximum is now 150.

### 5.1.1 — per-tool budgets are tiered (2026-10)

PATCH: thresholds and a reprompt string change inside an existing mechanism.
Medium-tier runs are unchanged; strong-tier runs are not comparable to 5.1.0 on
tool-heavy tasks.

- **Strong tier lifts the tool budgets.** `run_command` 15→60, `read_file`
  25→50, `grep`/`search_files` 15→40, `list_directory` 10→20. On the 50-task SWE
  canary, the medium budgets refused claude-haiku-4-5 in 40/50 runs, mostly
  `run_command`, which is its test runs. The model routed around the cap by
  spawning subagents for a fresh budget, calling `ask_user` in autonomous mode,
  and deleting its own repro scripts. Claude Code, on the same model and tasks
  with no caps, peaked per task at 51 non-search shell calls, 50 searches and 26
  reads. ([#236](https://github.com/nedonatelli/sidecar/issues/236))
- **The refusal only points at `ask_user` when a clarification UI can answer it.**
  A headless run (the SWE driver, the eval) has none, and was told to ask anyway.
- **Refusals are recorded** as `tool_budget` decisions, so trajectories and
  `summarizeDecisions` count them.

Measured (Haiku 4.5, canary, scaffold-on, 150 iterations): **31/50** against
30/50 at 5.1.0. That's 4 gained and 3 lost, McNemar p = 1.0, so resolve rate is
**neutral**. Across all 50 tasks, refused calls went from 157 to 15 (runs hitting
a budget: 40 → 8) and `spawn_agent` workarounds from 45 to 0. The remaining 15 are
`run_command` at its new cap of 60, on 8 tasks: SideCar runs searches through
`run_command` too, so it needs more shell calls than Claude Code's split counts
suggested. Mean turns rose 60→69 at flat wall time, because work the subagents
used to do now runs in the main loop. The change ships for run correctness, not
score. Full comparison: `bench/swe/results/2026-10-20-haiku45/`.

### 5.1.0 — the adversarial critic is removed (2026-08)

MINOR: a scaffold mechanism was **removed**, so the scaffold descriptor no
longer carries a `critic` feature key. Behavior is unchanged for default
installs (the critic shipped default-off), but manifests either side of this
boundary differ in shape.

- **Critic removed entirely.** The adversarial critic (`critic.ts`,
  `criticHook.ts`, the `analysisCritic` hook, `sidecar.critic.*` settings, the
  `critic` router role, the `critic-only` ablation arm, and the
  `runLlmCritic` scaffolding-profile trigger) is deleted. It had shipped
  default-off since the SWE-bench ablation measured it as actively harmful
  (~7.5× faster termination, MORE empty patches — a blocking model-judges-model
  verdict sent weak models chasing phantom findings and over-editing). With no
  measured benefit and a real maintenance cost, it is gone rather than dormant.
  Deterministic verification (completion gate, lint, tests, syntax) remains the
  load-bearing layer.

### 5.0.0 — checks must PASS, and silence is not an answer (2026-08)

MAJOR twice over: a gate's verification semantics changed (red-check refusal)
and a new default-on mechanism was added (empty-turn reprompt). Results either
side of this boundary are **not** directly comparable.

- **Red-check completion gate.** The gate verified that checks RAN, not that
  they PASSED — v0.122 gemma4 ran `tsc --noEmit`, saw both errors, wrote
  "this is expected, the compiler hasn't picked up the change," and finished
  with a broken import (`rename-propagates-to-cross-file-caller`, the one
  fleet-universal failure). A failing verification result (shared
  `isFailingCheckOutput` predicate, single-sourced with the 4.0.4 reprompt
  escapes) now refuses completion at most twice, with wording that explicitly
  allows an honest could-not-complete report to exit. A new mutation stales
  the flag — the model is fixing, and the normal re-verification
  requirements re-arm it. Fix work in response is primary work: the
  keep-best ratchet does not arm on this injection.
- **Empty-turn reprompt.** A turn with no text and no tool call ended the
  run as 'natural' completion. Observed as recorded failures on three models
  (granite ×2, deterministic across runs; ministral ×1), always right after
  a successful read. One bounded continue-reprompt; recurring silence still
  ends the run.
- **Tool prompt surface** (same batch): ask_user replies framed as
  `The user answered: "…"` in the standard tool_output wrapper — the only
  bare-string result on the surface was being discounted (north-mini-code
  re-asked an already-answered question); search_files retries bare terms as
  name substrings and teaches names-vs-contents; run_tests' no-runner hint
  is workspace-aware (no more pytest suggestions at TypeScript); read_file
  on a directory names list_directory instead of leaking raw EISDIR.
- **Eval-harness companion** (not scaffold runtime): the cooperative user
  now also answers a run that ends on a genuine clarifying question in chat
  text, once, so ask-in-text models are measured on whether they USE the
  answer — the same bar the ask_user path has always had.

### 4.0.4 — intent-aware reprompt escapes: run state over request phrasing (2026-08)

PATCH. Firing-condition tuning within the action-reprompt and fence-coercion
mechanisms — no change to which mechanisms run.

The "No tool calls detected" trigger classified turns by the REQUEST's shape
(action verb + file path) with no awareness of run state, so it fired on
text-only turns that were the legitimate end of the work. Two evidence-keyed
escapes:

- **Read request already answered**: the request is read-only
  (`!isMutationRequest`) and non-error read-shaped results exist since the
  user's real message — the text-only turn is the deliverable.
- **Mutation verified done**: a successful mutation is followed by a CLEAN
  verification result (run_command/run_tests/get_diagnostics, no error flag,
  no failing-output signature). The text-only turn is a completion summary.
- **A red check blocks the second escape outright** — nonzero exit codes,
  `error TS…`, `FAILED`, `Traceback` keep the pressure on. (gemma4,
  2026-08-07: rationalized failing tsc output and quit with a broken import;
  no escape may make that exit easier.)
- **Deferred-intent text keeps the reprompt** regardless of prior work —
  "Next, I will…" then stopping is still a stall.
- Not included (needs an A/B): a clarifying-question escape. It would fight
  the measured "Shall I proceed?" stall-detection clause; distinguishing
  disambiguation-with-candidates from permission-stalling is future work.

### 4.0.3 — cycle detection distinguishes hammering from recovery (2026-08)

PATCH. Threshold and exemption tuning within the cycle-detection mechanism —
no change to which mechanisms run.

The tolerances were inverted: blind byte-identical resubmission got
`cycleDetectionMinRepeats + 1` = **11** chances, while the prescribed recovery
loop (read the file, then retry — exactly what the edit errors instruct) formed
a length-2 pattern that bailed after **2** cycles, before `edit_file`'s
3rd-failure escalation tier could run.

- **Consecutive-identical threshold decoupled and fixed at 4.** As config+1 it
  silently rose 4→11 when the normalized default went 3→10 — tolerance meant
  for varying-content retries applied to resubmissions that get the same
  deterministic answer every time.
- **New identical-mutation pass**: byte-identical mutation calls counted
  ACROSS interleaved reads; 4th occurrence bails. Evidence: gemma4
  (`thinking-missing-await-in-loop`) sent one failing edit at positions
  10/14/15/17/18 — longest consecutive streak 2, so nothing fired until a
  [read, edit, edit] block happened to repeat verbatim.
- **Recovery-shape exemption** for length-2..4 pattern bails (exact and
  normalized): a pattern containing a read of a file under active mutation is
  the model doing work — reading a larger slice, retrying per instructions.
  Truly stuck variants still bail via the identical-mutation pass (a
  content-identical pattern necessarily repeats its mutation byte-for-byte).
- Granite baseline evidence: `no-op-recognition`, `run-fix-iteration-cycle`,
  `thinking-semantic-version-compare`, `dogfood-rename-no-corruption` all died
  as "pattern of length 2/3" mid-recovery.

### 4.0.2 — the "already done" signal disarms the act-now machinery (2026-08)

PATCH. Firing-condition tuning within two existing mechanisms — no change to
which mechanisms run.

- **Action reprompt stands down** when the newest tool evidence is a
  "No change needed" / already-applied result. A text-only completion turn
  after that signal is the model obeying the message's own instruction ("if
  the task is complete, say so and finish") — re-prompting it to use tools
  re-entered the edit loop.
- **Fence-write coercion stands down** under the same evidence: a final-state
  code fence after "No change needed" is a completion summary, not an
  unapplied edit, and synthesizing a `write_file` from it fed the loop.
- **Evidence walk**: newest-first through tool-result batches, past read-only
  results and synthetic `[`-prefixed injections; any successful mutation
  ("File edited/written") or the user's real request ends the walk. Marker
  predicate (`isNoChangeNeededResult`) single-sourced with the completion
  gate's no-op-edit bookkeeping.
- **Why**: without this, 4.0.1's messages and the loop fought each other —
  gemma4 obeyed "say so and finish" and was re-prompted straight back into
  re-fixing an already-correct file (fix-wrong-comparison-operator,
  2026-08-05: 14 wasted iterations). Both suppressions log, so firing counts
  are observable in run logs.

### 4.0.1 — landed-fix recognition in the rewrite guards (2026-08)

PATCH. Tunes recognition within two existing guards — no change to which
mechanisms run.

- **`isEditAlreadyApplied` gains an exact-outcome signal**: the edit is
  reported "already applied" when the replacement text is present verbatim
  exactly once and the searched-for text is gone. The token heuristic compares
  identifier sets, so an edit whose only delta is an operator (`a < b` →
  `a >= b`) was invisible to it and read as "search string not found" forever.
- **The enforce-edit-over-rewrite guard confirms instead of blocking** when the
  write content is identical (modulo CRLF / trailing newline) to the file's
  current state — "No change needed … the file is in the state you want" —
  instead of claiming the rewrite "keeps re-introducing the bug".
- **Evidence** (gemma4:e4b, `fix-wrong-comparison-operator`, 2026-08-02 and
  2026-08-05 trajectories): the fix landed via `edit_file` on iteration 2 and
  verified clean with `tsc --noEmit`; the model then burned 14 iterations
  re-sending the edit ("search string not found") and re-stating the file
  (blocked with the clobber lecture), never once being told the fix was in.
  Both retry shapes now get an explicit "already done — finish" signal.

### 4.0.0 — edit_file collapses to one operation (2026-07)

MAJOR. A mechanism was removed and the repair path changed, so results either
side of this boundary are **not** directly comparable.

- **`insert_before` / `insert_after` / `new_text` are gone**, along with the V2
  insert convention (`editFile.insertApiV2`) and the `splitFusedAnchor` recovery.
- **Why:** the field names contradicted their own semantics. `insert_after` was
  documented as the payload while its name reads as a position, and the V1 schema
  declared no field for the payload at all — so a model taking the plain-English
  reading had nowhere to put the new code. It was not improper tool use; the
  intent was inexpressible.
- **Evidence** (gemma4:e4b, `lh-calculator-session`, 3 reps per arm, frozen HEAD,
  thinking on): ten pathological events under the V1 insert surface — eight
  bounces for a dropped `path`, eight fused-anchor "recoveries" that reported
  `File edited` while duplicating text five times over, two resulting ambiguity
  errors — versus **zero** of any kind under V2. Pass rate 1/3 → 2/3, which at
  n=3 is noise; the mechanism counts are the result.
- **Rather than ship the naming fix**, the surface is gone. Every comparable
  agent (Claude Code, Aider, Cline, OpenAI apply_patch) exposes a single
  span-replacement primitive, because one unambiguous operation beats several
  overlapping ones. Insertion is now the standard idiom: anchor in `search`,
  anchor repeated in `replace` alongside the new code.
- **Risk carried:** `insert_*` existed to prevent weak models sending only the
  new text in `replace` (which means _delete the function_ — qwen2.5-coder and
  llama3.2 both failed that way in v0.119). The compensating guards are the
  duplicated-tail repair, the missing-`search` inference and the syntax gate.
  That regression must be re-measured, not assumed.

### 3.1.0 — adaptive scaffolding on by default + learned tiers (2026-07)

MINOR. The default arm composition changed, so runs either side of this boundary
compare only when their per-arm feature snapshots match.

- **`sidecar.adaptiveScaffolding.enabled` defaults to `true`.** Scaffolding is now
  tuned to the model's capability tier out of the box.
- **Tiers are learned, not parsed from the filename.** `parseParamSizeB` read
  `qwen2.5-coder:7b` (5/5 dogfood) and `llama3.2` (2/5) as the same `weak` tier,
  and could not parse `qwen3.5:latest` at all. Precedence is now: user override →
  observed performance in this workspace → tested baseline (`modelBaselines.ts`) →
  name heuristic. Promotion requires the model to have succeeded WITHOUT the
  scaffolding ever firing; demotion needs only failures. (Promoting on success
  alone is circular — a model may be succeeding _because_ of the scaffolding.)
- **`strong` no longer cuts the verification budget.** `maxActionReprompts` and
  `maxGateInjections` were 1; both are back to 2, at parity with `medium`. Strong
  keeps only the latency relaxations (burst cap 16, compression 0.75, deeper
  compaction).

Evidence for the flip:

| tier     | verdict                                                                                                                                                                                                                                                                                                                                                                                 |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `medium` | **Provable no-op.** Every knob is now BUILT from the constant its call site falls back to, so "flag on" and "flag off" are the same run. Pinned by `scaffoldingProfileNeutrality.test.ts`.                                                                                                                                                                                              |
| `weak`   | **Measured flat.** llama3.2 2/5→2/5, ministral-3 5/5→5/5, granite4.1 5/5→5/5 (dogfood, 2 trials, both arms). Not one case moved.                                                                                                                                                                                                                                                        |
| `strong` | **The cut was never justified.** Against claude-sonnet-5: the action reprompt fired in **10/10 runs** — a frontier model narrates instead of acting at least once per task — so a budget of 1 runs permanently at its ceiling. The completion gate injected **0 times**, so the 2→1 cut had never been exercised at all: absence of evidence, not evidence of safety. Budgets restored. |

Note that a `weak` tier's `runLlmCritic: false` is not a guard removal on a default
install — the critic is opt-in (`sidecar.critic.enabled` defaults false) and is
checked before the tier is consulted.

### 3.0.0 — always-on dispatch guards + edit-recovery + text-repair (2026-07)

MAJOR. Shared-path changes, each verified against a live trajectory:

- **Example-replay guard** (always on, no flag): the executor bounces any tool
  call whose arguments verbatim-match the example embedded in that tool's own
  description — restricted to examples with ≥2 arguments, because a legitimate
  single-key call can collide with a single-arg example by coincidence (an
  eval fixture independently chose `src/utils.ts`, the exact path in
  `read_file`'s example). Evidence: llama3.2 replayed the `ask_user` auth-flow
  example (3 args) on a bare "hi" (live chat) and the `edit_file` example
  (3 args) on "thanks, great work!" (guard-probe sweep, 5 models × 4 config
  arms — the only replay signature that fired in 100 probe cases).
- **Escalating dispatch bounces**: schema / malformed-JSON / example-replay /
  unknown-tool bounce messages escalate on consecutive identical repeats
  (2nd: do-not-resubmit; 3rd+: stop-retrying-change-approach) and reset on any
  successful call of the tool.
- **textParsing repair expansion**: the bare-JSON path recognizes the OpenAI
  function-call shape (`{"type":"function","function":{name,parameters}}`) and
  salvages truncated emissions missing the final brace (both observed live from
  llama3.2 — previously dropped silently, making the model look like it
  "chose" not to act). The bare-JSON scanner also counts braces string-aware:
  it previously ran its depth off on a `{` inside a JSON string value, so a
  perfectly-formed rename arrived as `edit_file({})`.
- **Two-tier edit recovery**: when a model's `search` does not match, the intent
  matcher APPLIES its guess only when the winning region beats the runner-up by
  ≥3 distinctive words, and otherwise SUGGESTS the region and writes nothing.
  The bar is measured, not chosen: over 1,700 real edits mined from eleven
  repositories' git history, that margin commits 177 times and is wrong zero
  times, where margin 1 is wrong 6.7% of the time. Suggest-only is the safe
  alternative but costs capability (qwen2.5-coder 5/5 → 3/5 on dogfood); this
  keeps the recovery at zero measured corruption risk.
- **Action reprompt actually fires**: it had been dead on every turn following a
  tool call (tool results are `role:'user'` messages with no text, and that empty
  text was read as the user's intent), so a model that read a file and then
  described the edit in prose terminated as "done" with the file untouched.

Cross-boundary comparability: NOT comparable for weak-model runs —
llama3.2-class models gain tool calls that 2.x silently lost, so resolve/pass
rates measured before and after this version differ for harness reasons, not
model reasons.

### 2.1.0 — keep-best ratchet default-on (2026-07)

MINOR. `sidecar.scaffolding.keepBest` defaults to **true**: every default-config
run now arms the ratchet at the scaffold boundary and reverts unproven
scaffold-tail changes at termination. Evidence (150-run 3-arm SWE campaign,
qwen2.5-coder:7b, Verified N=50): over-engineering rate 36.6→29.6KB mean patch,
6/50 live reverts, no possible resolve harm (0 resolves in all arms — the
resolve non-regression is vacuous at this weight class and must be re-verified
on a resolvable class; recorded in the ROADMAP Prove-or-Prune Ledger). The
asymmetry that justified default-on: the completion gate (whose tail-pressure
causes the damage) has always shipped default-on; its counterweight should too.

### 2.0.1 — keep-best ratchet threshold tightened (2026-07)

PATCH. `DEFAULT_OVER_ENGINEER_BYTES` (in
[`keepBestRatchet.ts`](https://github.com/nedonatelli/sidecar/blob/main/src/agent/loop/keepBestRatchet.ts)) tightened from
4096 to 0. A local SWE-bench repro of scaffold-on bail-early found a concrete
case — a 536-byte wrong edit to an unrelated file, driven by a cycle-detection
bail — that slid under the old 4 KB threshold untouched. A byte-size gate alone
can't tell a legitimate small addition from a wrong one, so the default now
reverts **any** scaffold-tail growth that didn't earn a proven test-signal
improvement (a new passing test, or the project suite going green). Raise
`sidecar.scaffolding.keepBestOverEngineerBytes` (or `RatchetOptions.overEngineerBytes`)
to tolerate some unverified growth again. No mechanism added/removed —
comparable with 2.0.0 runs as long as both used the ratchet at all; note the
threshold value itself when comparing patch-bloat-sensitive results.

### 2.0.0 — verification-vertical + do-no-harm (2026-07)

Adds, over 1.x (superseded — the current baseline is 4.0.0, top of the registry above):

- **Keep-best ratchet** (`keepBestRatchet`) — Pareto-safe scaffolding: snapshot →
  apply → re-verify → revert on regression. Scaffolding can't turn a passing run
  into a failing one. _Default OFF._
- **Mutation testing** (`mutation_test` tool) — verify-the-verifier.
- **§5 analytic-bound gate** (`analyticBoundsGate`) — a declared value bound not
  enforced in code is flagged/blocked. _Default OFF (advisory always)._
- **§5 property-based test synthesis** (`synthesize_property_test` tool).
- **Prompt-injection guard** (`injectionGuard`) — fence untrusted tool output as
  data. _Default ON._
- **Strengthened tier-1 tool-call repair** — raw-control-char escaping inside
  string values (multi-line `write_file`/`edit_file` recovery), NaN/Infinity.

**Note on the ablation arm:** at 2.0.0 the SWE-bench `scaffold-on` arm
([`bench/swe/arms.ts`](https://github.com/nedonatelli/sidecar/blob/main/bench/swe/arms.ts)) still enables only the pre-2.0
mechanism set — **completion gate · critic · auto-fix · adaptive scaffolding ·
impact gate · numerical-contract gate**. The 2.0 additions are built but not yet
opted into the arm, so a 2.0.0 `scaffold-on` run isolates the _established_
scaffold. The version differs from 1.x because the SHARED path (repair internals,
gate wiring) changed. (2.1.0 shipped that comparison — see its entry above —
followed by 2.0.1, 3.0.0, 3.1.0, and the current 4.0.0.)

### 1.x — pre-2026-07 baseline

Completion gate · adversarial critic · auto-fix · adaptive scaffolding · impact
gate · numerical-contract gate. (Not retroactively versioned; treated as the 1.x
band. Runs from this era lack a `scaffoldVersion` field in their manifest.)

## How it's recorded

- **`run.manifest.json`** (per SWE-bench run) — `scaffoldVersion` + a per-arm
  `scaffold` snapshot (`describeScaffold({...config, ...armOverride})`), so each
  arm's exact active mechanisms are logged.
- **Ablation report** (`ablation.md`) — the reproducibility envelope prints
  `scaffold version: X.Y.Z`.
- **Comparing runs:** match `scaffoldVersion` AND the per-arm feature snapshot.
  If they differ, the delta between two campaigns may be scaffold change, not
  model/task change.
