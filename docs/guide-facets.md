---
title: Typed Sub-Agent Facets
layout: docs
nav_order: 11
nav_section: 'Guides'
---

# Typed Sub-Agent Facets

Facets are named specialist agents you dispatch in parallel against a shared task. Each facet runs in an isolated Shadow Workspace with its own tool allowlist, preferred model, and composed system prompt. When they finish, their diffs are collected into a single batch review — one Accept/Reject pass, not N separate prompts.

---

## What Facets Are

A facet is a sub-agent with an enforced role. "Enforced" is the key word: the `test-author` facet can only call `read_file`, `write_file`, `edit_file`, `grep`, `get_diagnostics`, `run_tests`, and `find_references` — it literally cannot call `git_commit` or `run_command`. The `security-reviewer` facet cannot write files at all. The toolset is compiled down to a permission list that the dispatcher enforces at the tool-dispatch layer, not just in the prompt.

This is distinct from telling the main agent "you are now acting as a security reviewer." In that case the model still has access to all tools and can drift out of role. With facets, the boundary is structural.

Each facet run:

1. Spins up its own agent loop.
2. Gets the same task prompt you entered.
3. Branches off the current `HEAD` into a fresh git worktree (`forceShadow: true`).
4. Runs to completion without touching your main tree or any other facet's in-progress writes.
5. Captures its diff into a pending result (`deferPrompt: true`), so no mid-run quickpick fires.

After all selected facets complete, a single review UI collects the diffs side-by-side.

### How Facets Differ from `/bg` and `/fork`

|                              | `/bg` background agent                             | `/fork` parallel solve                                                     | Facets                                                                    |
| ---------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **What it does**             | Runs a generic agent on an independent task        | Runs the same task N times with natural variance to pick the best approach | Dispatches N distinct roles against the same task                         |
| **Tool surface**             | Full agent tool registry                           | Full agent tool registry                                                   | Per-facet allowlist — enforced at dispatch                                |
| **Model**                    | Global `sidecar.model`                             | Global `sidecar.model`                                                     | Per-facet `preferredModel`                                                |
| **Isolation**                | Optional Shadow Workspace                          | Forced Shadow Workspace                                                    | Forced Shadow Workspace                                                   |
| **Review**                   | Per-agent, fires during or after the run           | Single winner — pick one diff                                              | Batch — Accept/Reject each facet's diff                                   |
| **Inter-agent coordination** | None                                               | None                                                                       | Typed RPC bus — facets can call methods on peers                          |
| **When to use**              | You have multiple independent tasks to run at once | You want the best of several autonomous attempts at one task               | You want specialised roles to cover different dimensions of the same task |

The decision rule: **Facets** when the work has natural role boundaries (code + tests + docs + security audit). **`/fork`** when you want the agent to try the same thing multiple ways and you'll pick the winner. **`/bg`** when the tasks are genuinely independent.

---

## The Built-in Facets

SideCar ships nine facets embedded in the extension. They are always available — no disk I/O, no broken-unpack footgun.

| ID                      | Display Name          | Tool Allowlist                                                                                                                                     | Skill Bundle                             | When to Use                                                                                                                                                                                                                  |
| ----------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `general-coder`         | General Coder         | `read_file`, `write_file`, `edit_file`, `search_files`, `grep`, `list_directory`, `get_diagnostics`, `run_tests`, `run_command`, `find_references` | —                                        | General implementation work, coordinating across other facets when the task crosses domain boundaries.                                                                                                                       |
| `latex-writer`          | LaTeX Writer          | `read_file`, `write_file`, `edit_file`, `grep`, `list_directory`                                                                                   | `technical-paper`                        | Editing `.tex` / `.bib` files, maintaining math blocks and cite-keys. Publishes equations via RPC so sibling facets can stay in lock-step.                                                                                   |
| `signal-processing`     | Signal Processing     | `read_file`, `write_file`, `edit_file`, `grep`, `get_diagnostics`, `run_tests`, `find_references`                                                  | `signal-processing`, `numerical-methods` | FFT, filter design, wavelet and transform code. Attentive to numerical stability, DC bin, Nyquist, and windowing edge cases.                                                                                                 |
| `frontend`              | Frontend              | `read_file`, `write_file`, `edit_file`, `search_files`, `grep`, `get_diagnostics`, `run_tests`                                                     | `react`                                  | Component extraction, accessible markup (ARIA + semantic HTML), matching existing styling conventions before inventing new abstractions.                                                                                     |
| `test-author`           | Test Author           | `read_file`, `write_file`, `edit_file`, `grep`, `get_diagnostics`, `run_tests`, `find_references`                                                  | —                                        | Writing tests covering behavior, edge cases, and regression invariants. Probes untested branches via `get_diagnostics`.                                                                                                      |
| `technical-writer`      | Technical Writer      | `read_file`, `write_file`, `edit_file`, `grep`, `list_directory`, `find_references`                                                                | `technical-paper`                        | Keeping README, JSDoc, and changelog entries in sync with the code on the branch. Favours concrete examples and file-path references.                                                                                        |
| `security-reviewer`     | Security Reviewer     | `read_file`, `grep`, `search_files`, `find_references`, `list_directory`, `git_diff`                                                               | `cybersecurity-architecture`             | **Read-only.** Audits diffs and nearby code for injection, auth gaps, secret exposure, unsafe deserialization, and supply-chain risk. Reports findings with `file:line` references — never edits.                            |
| `architecture-reviewer` | Architecture Reviewer | `read_file`, `grep`, `search_files`, `find_references`, `list_directory`, `git_diff`, `project_knowledge_search`                                   | `software-architecture`                  | **Read-only.** Reviews subsystem structure and coupling from code read this session — maps before judging, cites `file:symbol` per finding, and checks whether a pattern already exists before recommending it. Never edits. |
| `data-engineer`         | Data Engineer         | `read_file`, `write_file`, `edit_file`, `grep`, `run_tests`, `run_command`                                                                         | —                                        | ETL / streaming pipelines, schema migrations, query optimizations. Validates every schema change against downstream consumers before proposing it.                                                                           |

The `security-reviewer` allowlist is worth noting explicitly: it does not include any write tool. The facet is structurally incapable of modifying files, regardless of what the model attempts.

---

## Dispatching Facets

### Command Palette

Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run:

```
SideCar: Facets: Dispatch Specialists
```

A multi-select QuickPick opens listing every available facet (built-ins first, then project and user facets). Select one or more and press Enter.

### The Task Prompt

After selecting facets, you are prompted for a task description. All selected facets receive the **same task prompt**. Write it in terms of the overall goal — each facet interprets it through its own role and tool constraints.

Good:

```
Add rate limiting to the /api/auth/login endpoint
```

That is specific enough that `general-coder` implements it, `test-author` writes tests for the new behavior, `security-reviewer` audits the diff for bypass vectors, and `technical-writer` updates the API docs.

Vague tasks lead to vague output regardless of the facet model. Be specific.

### What You See During Dispatch

As facets run, the chat panel emits prefix-tagged output:

```
[facet general-coder dispatching: Add rate limiting to /api/auth/login...]
... general-coder's streaming output ...
[facet general-coder completed]

[facet test-author dispatching: Add rate limiting to /api/auth/login...]
... test-author's streaming output ...
[facet test-author completed]
```

Tool call events are also prefixed with the facet id (`general-coder:write_file`, `test-author:run_tests`) so you can follow which specialist is doing what.

Facets with `dependsOn` edges wait for their prerequisites before starting. Independent facets run concurrently up to the `sidecar.facets.maxConcurrent` cap (default 3).

---

## The Batched Review

When every selected facet has settled, a single review UI opens. You are not prompted during the run — the `deferPrompt: true` flag captures each diff in `SandboxResult.pendingDiff` and holds it until the batch completes.

### Per-Facet Actions

For each facet's result you can:

- **Accept** — applies the facet's diff to your main working tree via `git apply`. Parent directories are created if needed.
- **Show diff** — opens VS Code's native diff editor against the captured diff.
- **Reject** — discards the facet's shadow worktree. Nothing lands on disk.
- **Skip** — move past without deciding; the shadow is discarded at session end.

### Cross-Facet Overlap Warnings

Before the review UI, SideCar runs `planFacetReview`, which extracts the file paths each facet touched and detects overlaps. If `general-coder` and `test-author` both modified `src/auth/login.ts`, the review panel flags the overlap:

```
⚠ File overlap: src/auth/login.ts touched by general-coder and test-author
```

The overlap is informational — you can still accept both diffs, but you should inspect them before doing so. Accept the more authoritative one first; the second `git apply` will fail cleanly if there are conflicts, rather than silently overwriting.

### Facets That Failed

A facet that errors during its run appears in the batch result with `success: false` and an error message. Its entry still appears in the review UI so you can see what went wrong. No diff is offered for a failed facet; its shadow was never written.

---

## Writing Your Own Facets

A facet is a `.md` file with YAML-ish frontmatter. The body is the system prompt.

### Complete Example

```markdown
---
id: api-contract-tester
displayName: API Contract Tester
preferredModel: claude-haiku-4-5
toolAllowlist: ['read_file', 'grep', 'run_tests', 'edit_file', 'write_file']
skillBundle: []
dependsOn: ['general-coder']
rpcSchema: { 'reportFinding': { 'params': { 'endpoint': 'string', 'severity': 'string', 'detail': 'string' } } }
---

You are an API contract tester. For every change to a route handler:

1. Diff the OpenAPI schema (or equivalent) to detect backward-incompatible changes.
2. Verify each changed endpoint against its declared response schema.
3. Write or update contract tests that fail if a breaking change ships unreviewed.
4. Call rpc.general-coder.reportFinding (if available) to surface any breaking changes found.

Focus on: removed fields, changed types, new required parameters, modified status codes.
Do not add functionality — only write defensive tests.
```

### Frontmatter Field Reference

| Field            | Required | Type                  | Description                                                                                                                                                       |
| ---------------- | -------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | Yes      | string                | Unique identifier. Must match `/^[a-z0-9][a-z0-9_-]*$/`. Disk facets with the same `id` as a built-in override the built-in.                                      |
| `displayName`    | Yes      | string                | Human-readable label shown in the QuickPick and review UI.                                                                                                        |
| `toolAllowlist`  | No       | JSON array of strings | Tool names the facet is permitted to call. Omit to inherit the full orchestrator tool registry. An empty array `[]` means no tools — the facet is a pure thinker. |
| `preferredModel` | No       | string                | Model pinned for this facet's run. Leave blank to use the global `sidecar.model`.                                                                                 |
| `skillBundle`    | No       | JSON array of strings | Skill IDs merged into the facet's system prompt. Use skills from `SkillLoader` (built-in or `~/.claude/commands/`, `<workspace>/.sidecar/skills/`).               |
| `dependsOn`      | No       | JSON array of strings | Facet IDs this facet must wait for. The dispatcher walks a DAG in topological order; cycles are detected at load time and rejected.                               |
| `rpcSchema`      | No       | JSON object           | Methods this facet exposes to peers. Each key is a method name; each value is an object with optional `params` and `returns` hints.                               |

### Parsing Rules

Values that start with `[` or `{` are parsed as JSON — that is how `toolAllowlist`, `dependsOn`, `skillBundle`, and `rpcSchema` work. Scalar values (`id`, `displayName`, `preferredModel`) are plain strings. You do not need a full YAML parser to write a valid facet file.

### File Locations

Facets are discovered in this order (later sources override earlier on `id` collision):

1. **Built-ins** — embedded in the extension, always available.
2. `<workspace>/.sidecar/facets/*.md` — project-local facets. Loaded only when the workspace is trusted. Commit these to share facets with your team.
3. Paths listed in `sidecar.facets.registry` — absolute paths to individual `.md` files, loaded alongside built-ins. Use for personal facets in a dotfiles repo or a shared team registry checked out separately.

Parse errors in individual disk facets never abort the load. The dispatcher always has the built-in catalog as a floor, so a malformed project facet surfaces an error message without leaving you with an empty specialist list.

### The `dependsOn` Field

Use `dependsOn` to enforce ordering when one facet's output is an input for another.

```markdown
---
id: docs-writer
displayName: Docs Writer
toolAllowlist: ['read_file', 'write_file', 'edit_file', 'grep']
dependsOn: ['general-coder']
---

You document the code changes made by the general-coder facet.
Read the edited files and update inline JSDoc, README, and CHANGELOG.
```

The dispatcher computes topological layers from all selected facets' `dependsOn` edges. `general-coder` runs first (no dependencies), `docs-writer` runs after it completes. Facets in the same layer run concurrently.

**Cycle detection** runs at load time. A `dependsOn` graph with a cycle (`A → B → A`) is rejected with a `FacetValidationError` and the entire disk-facet registry falls back to built-ins only. Self-dependency (`dependsOn: ["my-own-id"]`) is also rejected immediately.

When you select a subset of facets for dispatch (e.g., `docs-writer` but not `general-coder`), the dependency edge becomes a no-op for ordering purposes — `docs-writer` still runs, just without waiting.

### The `rpcSchema` Field

RPC lets facets communicate. When a facet declares an `rpcSchema`, the dispatcher generates `rpc.<facetId>.<method>` tools for every other facet in the same batch.

Declare a method your facet will answer:

```markdown
---
id: latex-writer
rpcSchema:
  { 'publishMathBlock': { 'params': { 'symbol': 'string', 'latex': 'string' }, 'returns': { 'ok': 'boolean' } } }
---
```

A sibling facet (`signal-processing`, for example) can then call:

```
rpc.latex-writer.publishMathBlock({ "args": { "symbol": "H_n", "latex": "H_n(z) = \\sum_{k=0}^{N-1} h[k] z^{-k}" } })
```

The model sees `rpc.latex-writer.publishMathBlock` in its tool catalog and calls it like any other tool. The bus resolves the call to the registered handler and returns the result synchronously.

**The bus never rejects.** Every RPC call resolves to either `{ "ok": true, "value": ... }` or `{ "ok": false, "errorKind": "no-handler" | "timeout" | "handler-threw", "message": "..." }`. A facet loop that tries to call a peer that hasn't registered a handler gets a typed error result it can read and react to — the loop does not crash.

After each batch, `rpcWireTrace` records every RPC attempt: caller, receiver, method, args, outcome, and elapsed milliseconds. The review UI exposes this trace so you can see what facets communicated.

---

## Configuration

All facets settings are under `sidecar.facets.*`.

| Setting                        | Default | Description                                                                                                                                                                                                                                 |
| ------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.facets.enabled`       | `true`  | Master toggle. When `false`, `SideCar: Facets: Dispatch Specialists` shows a one-line info toast instead of the picker.                                                                                                                     |
| `sidecar.facets.maxConcurrent` | `3`     | Maximum facets running in parallel within a single topological layer. Clamped 1–16. Higher values finish wide batches faster at the cost of more concurrent Shadow Workspaces and more simultaneous LLM requests.                           |
| `sidecar.facets.rpcTimeoutMs`  | `30000` | Milliseconds a `rpc.<peerId>.<method>` call waits before the bus resolves it as `{ ok: false, errorKind: 'timeout' }`. Clamped 1000–300000 (1 second to 5 minutes). The bus never hangs the calling facet — timeouts become typed outcomes. |
| `sidecar.facets.registry`      | `[]`    | Array of absolute paths to individual facet `.md` files. Loaded alongside built-ins and `.sidecar/facets/*.md`. Use for personal facets in a dotfiles repo or a shared team registry.                                                       |

### Example: Raise Concurrency for a Fast Batch

```json
"sidecar.facets.maxConcurrent": 6
```

With this set, a six-facet dispatch where no facet has `dependsOn` edges runs all six in parallel (subject to rate limits on your LLM backend).

### Example: Team Registry

Check a directory of `.md` facet files into a shared repo, then point each developer's user settings at it:

```json
"sidecar.facets.registry": [
  "/Users/alice/company-facets/api-contract-tester.md",
  "/Users/alice/company-facets/migration-reviewer.md"
]
```

Or, if the repo is always cloned to the same relative path:

```json
"sidecar.facets.registry": [
  "${env:HOME}/company-facets/api-contract-tester.md"
]
```

---

## When to Use Facets vs. `/bg` vs. `/fork`

| Scenario                                                                                                                       | Recommended                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| "Write tests and update docs for this PR."                                                                                     | **Facets** — `test-author` + `technical-writer` in parallel, both reading the same branch.                          |
| "Refactor the auth module, and separately update the CI config."                                                               | **`/bg`** — two independent tasks with no shared output.                                                            |
| "Implement this feature — give me three different approaches to choose from."                                                  | **`/fork`** — same task, natural variance, pick the winner.                                                         |
| "Audit the new payment endpoint for security issues, implement the missing test coverage, and document the rate-limit policy." | **Facets** — `security-reviewer` (read-only audit), `test-author`, and `technical-writer`. Natural role boundaries. |
| "Clean up this file."                                                                                                          | **Main agent** — single task, no role specialization needed.                                                        |
| "Run the full regression suite and file a bug report if it fails."                                                             | **`/bg`** — independent background task, not role-specific.                                                         |

The practical signal: if you find yourself about to give different instructions to different agents based on their role, that is a facet dispatch. If you want parallel independent work, that is `/bg`. If you want to compare approaches to the same thing, that is `/fork`.

---

## Practical Recipes

### Feature Development with Full Coverage

Select `general-coder`, `test-author`, and `technical-writer`. Task:

```
Implement caching for the getUserProfile() endpoint. Cache in Redis,
TTL 5 minutes, invalidate on profile update.
```

`general-coder` implements the cache layer. `test-author` writes tests covering cache hits, misses, TTL expiry, and invalidation. `technical-writer` updates the inline JSDoc and any relevant API docs. The three diffs appear in one review.

### Security-Focused Code Review Before Merging

Select `security-reviewer` only. Task:

```
Audit the diff on this branch for security issues.
Focus on the new /api/admin/* endpoints.
```

`security-reviewer`'s read-only allowlist means it can examine files, grep for patterns, and read the git diff — but cannot write anything. Its output is a findings report in the review panel, not a patch.

### DSP / Signal Processing Paper

Select `signal-processing` and `latex-writer` with an `rpcSchema` on `latex-writer` for `publishMathBlock`. Task:

```
Implement the Goertzel algorithm in dsp/goertzel.ts.
Keep the LaTeX paper in sync with the implementation.
```

`signal-processing` implements the algorithm and calls `rpc.latex-writer.publishMathBlock` with each load-bearing equation. `latex-writer` updates the corresponding `.tex` file. Both diffs land in the batch review.

### Adding a New Data Pipeline

Select `general-coder`, `data-engineer`, and `test-author` with `data-engineer` having `dependsOn: ["general-coder"]`. Task:

```
Add a pipeline that ingests daily user activity CSVs into the
analytics.user_events table. Include schema validation and idempotency.
```

`general-coder` and `test-author` run first (no `dependsOn`). After `general-coder` completes, `data-engineer` reviews the new pipeline for schema contracts, downstream consumer impact, and query optimization opportunities, and adds any missing ETL scaffolding.
