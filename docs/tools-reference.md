---
title: Tools Reference
layout: docs
nav_order: 2
nav_section: 'Agent'
---

# Tools Reference

SideCar ships **80+ built-in tools** available to the agent loop. Most are always active; a subset requires an opt-in setting to appear in the catalog (gated tools). All tool calls stream output back to the chat panel in real time.

---

## Quick Reference

| Tool                                | Category           | Approval | Gating                                      |
| ----------------------------------- | ------------------ | -------- | ------------------------------------------- |
| `read_file`                         | File Operations    | No       | —                                           |
| `write_file`                        | File Operations    | Yes      | —                                           |
| `edit_file`                         | File Operations    | Yes      | —                                           |
| `delete_file`                       | File Operations    | Yes      | —                                           |
| `list_directory`                    | File Operations    | No       | —                                           |
| `run_command`                       | Shell & Execution  | Yes      | —                                           |
| `run_tests`                         | Shell & Execution  | Yes      | —                                           |
| `get_diagnostics`                   | Shell & Execution  | No       | —                                           |
| `system_monitor`                    | Shell & Execution  | No       | —                                           |
| `git_diff`                          | Git                | No       | —                                           |
| `git_status`                        | Git                | No       | —                                           |
| `git_stage`                         | Git                | Yes      | —                                           |
| `git_commit`                        | Git                | Yes      | —                                           |
| `git_log`                           | Git                | No       | —                                           |
| `git_push`                          | Git                | Yes      | —                                           |
| `git_pull`                          | Git                | Yes      | —                                           |
| `git_branch`                        | Git                | Yes      | —                                           |
| `git_stash`                         | Git                | Yes      | —                                           |
| `git_search_history`                | Git                | No       | —                                           |
| `reply_pr_comment`                  | GitHub             | Yes      | —                                           |
| `submit_pr_review`                  | GitHub             | Yes      | —                                           |
| `create_pr_review`                  | GitHub             | Yes      | —                                           |
| `mark_pr_ready`                     | GitHub             | Yes      | —                                           |
| `check_pr_ci`                       | GitHub             | No       | —                                           |
| `web_search`                        | Web & Search       | No       | —                                           |
| `display_diagram`                   | Web & Search       | No       | —                                           |
| `render_viz`                        | Web & Search       | No       | —                                           |
| `search_files`                      | Web & Search       | No       | —                                           |
| `grep`                              | Web & Search       | No       | —                                           |
| `find_references`                   | Web & Search       | No       | —                                           |
| `project_knowledge_search`          | Web & Search       | No       | `sidecar.projectKnowledge.enabled`          |
| `analyze_impact`                    | Code Graph         | No       | —                                           |
| `query_code_graph`                  | Code Graph         | No       | —                                           |
| `check_numerical_contracts`         | Code Graph         | No       | —                                           |
| `check_shape_consistency`           | Code Graph         | No       | —                                           |
| `db_list_connections`               | Databases          | No       | —                                           |
| `db_list_tables`                    | Databases          | No       | —                                           |
| `db_describe_table`                 | Databases          | No       | —                                           |
| `db_query`                          | Databases          | No       | —                                           |
| `db_execute`                        | Databases          | Yes      | —                                           |
| `db_migrate_up`                     | Databases          | Yes      | —                                           |
| `screenshot_page`                   | Vision & Browser   | No       | `sidecar.visualVerify.enabled`              |
| `analyze_screenshot`                | Vision & Browser   | No       | `sidecar.visualVerify.enabled`              |
| `open_in_browser`                   | Vision & Browser   | No       | `sidecar.visualVerify.enabled`              |
| `run_playwright_code`               | Vision & Browser   | Always   | `sidecar.visualVerify.enabled`              |
| `ask_user`                          | Agent Management   | No       | —                                           |
| `describe_tool`                     | Agent Management   | No       | —                                           |
| `update_plan`                       | Agent Management   | No       | `sidecar.plan.externalized` (default off)   |
| `query_history`                     | Agent Management   | No       | `sidecar.evalHistory.enabled` (default off) |
| `spawn_agent`                       | Agent Management   | No       | —                                           |
| `delegate_task`                     | Agent Management   | No       | Paid backends only                          |
| `switch_backend`                    | Agent Management   | Always   | —                                           |
| `get_setting`                       | Agent Management   | No       | —                                           |
| `update_setting`                    | Agent Management   | Always   | —                                           |
| `read_pdf`                          | PDF & Literature   | No       | —                                           |
| `index_pdf`                         | PDF & Literature   | No       | —                                           |
| `zotero_search`                     | PDF & Literature   | No       | —                                           |
| `zotero_get_item`                   | PDF & Literature   | No       | —                                           |
| `insert_citation`                   | PDF & Literature   | No       | —                                           |
| `extract_constraints`               | Doc-to-Test        | No       | `sidecar.docTests.enabled`                  |
| `synthesize_tests`                  | Doc-to-Test        | No       | `sidecar.docTests.enabled`                  |
| `classify_test_failure`             | Doc-to-Test        | No       | `sidecar.docTests.enabled`                  |
| `mutation_test`                     | Doc-to-Test        | Yes      | `sidecar.mutation.enabled`                  |
| `synthesize_property_test`          | Doc-to-Test        | No       | —                                           |
| `ingest_source`                     | Notebook Mode      | No       | `sidecar.notebookMode.enabled`              |
| `generate_briefing`                 | Notebook Mode      | No       | `sidecar.notebookMode.enabled`              |
| `generate_study_guide`              | Notebook Mode      | No       | `sidecar.notebookMode.enabled`              |
| `generate_faq`                      | Notebook Mode      | No       | `sidecar.notebookMode.enabled`              |
| `generate_timeline`                 | Notebook Mode      | No       | `sidecar.notebookMode.enabled`              |
| `generate_outline`                  | Notebook Mode      | No       | `sidecar.notebookMode.enabled`              |
| `research_create_project`           | Research Assistant | No       | `sidecar.research.enabled`                  |
| `research_add_hypothesis`           | Research Assistant | No       | `sidecar.research.enabled`                  |
| `research_log_experiment`           | Research Assistant | Yes      | `sidecar.research.enabled`                  |
| `research_add_observation`          | Research Assistant | No       | `sidecar.research.enabled`                  |
| `research_update_hypothesis_status` | Research Assistant | No       | `sidecar.research.enabled`                  |
| `research_list_projects`            | Research Assistant | No       | `sidecar.research.enabled`                  |
| `research_set_project_status`       | Research Assistant | No       | `sidecar.research.enabled`                  |
| `research_export_report`            | Research Assistant | No       | `sidecar.research.enabled`                  |
| `check_dependencies`                | CI & Profiling     | No       | `sidecar.deps.enabled`                      |
| `analyze_ci_failure`                | CI & Profiling     | No       | `sidecar.ci.analysis.enabled`               |
| `profile_code`                      | CI & Profiling     | Yes      | `sidecar.profiling.enabled`                 |
| `latex_compile`                     | LaTeX              | Yes      | `sidecar.latex.enabled`                     |
| `delegate_to_mcp`                   | MCP Delegation     | No       | `sidecar.mcpDelegation.enabled`             |
| `monorepo_packages`                 | Monorepo           | No       | `sidecar.monorepo.enabled`                  |
| `kickstand_list_loras`              | Kickstand          | No       | —                                           |
| `kickstand_attach_lora`             | Kickstand          | Yes      | —                                           |
| `kickstand_detach_lora`             | Kickstand          | Yes      | —                                           |

**Approval** — `Yes` means the tool pauses for user confirmation in normal mode. `Always` means it pauses even in autonomous mode and cannot be bypassed by `toolPermissions`.

**Custom tools** defined via `sidecar.customTools` are prefixed `custom_<name>` and always require approval.

---

> **Relevance gating:** rows showing `—` are not necessarily always advertised. The Kickstand tools appear only when the provider is Kickstand, the `db_*` tools only when at least one database profile is configured, and the `zotero_*` tools only when Zotero credentials are set (`RELEVANCE_GATED_GROUPS` in `tools.ts`). Tools absent from the catalog for these reasons are by design, not an error.

## File Operations

### `read_file`

Read the contents of a file at the given relative path.

| Parameter    | Type                                   | Required | Description                                                                                                                       |
| ------------ | -------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `path`       | string                                 | Yes      | Relative file path from the project root                                                                                          |
| `mode`       | `"full"` \| `"compact"` \| `"outline"` | No       | `full` (default) returns raw content. `compact` strips comments and blank-line runs. `outline` returns only top-level signatures. |
| `start_line` | number                                 | No       | First line to return (1-based). Use with `end_line` to read a range of a large file.                                              |
| `end_line`   | number                                 | No       | Last line to return (inclusive).                                                                                                  |

Use `full` mode when you plan to call `edit_file` afterward — the `search` argument must match verbatim.

---

### `write_file`

Create a new file or overwrite an existing file completely.

| Parameter | Type   | Required | Description                              |
| --------- | ------ | -------- | ---------------------------------------- |
| `path`    | string | Yes      | Relative file path from the project root |
| `content` | string | Yes      | Full file content to write               |

Overwrites without confirmation — call `read_file` first if the file may already exist. In Audit Mode, writes are buffered for review instead of touching disk.

**Requires approval.**

---

### `edit_file`

Edit an existing file by replacing an exact search string with a replacement.

| Parameter | Type   | Required | Description                                                                                |
| --------- | ------ | -------- | ------------------------------------------------------------------------------------------ |
| `path`    | string | Yes      | Relative file path from the project root                                                   |
| `search`  | string | Yes      | Exact text to find. Must match exactly one location — include enough context to be unique. |
| `replace` | string | Yes      | New text to substitute for the search match. Must differ from `search`.                    |

In Audit Mode, edits are buffered for review.

**Requires approval.**

---

### `delete_file`

Permanently delete a file at the given relative path.

| Parameter | Type   | Required | Description                              |
| --------- | ------ | -------- | ---------------------------------------- |
| `path`    | string | Yes      | Relative file path from the project root |

Only removes individual files — not directories. In Audit Mode, deletions are buffered for review.

**Requires approval.**

---

### `list_directory`

List the files and folders in a directory, one entry per line with type markers.

| Parameter | Type   | Required | Description                                                               |
| --------- | ------ | -------- | ------------------------------------------------------------------------- |
| `path`    | string | No       | Relative directory path from project root. Empty or `"."` lists the root. |

---

## Shell & Execution

### `run_command`

Execute a shell command in a persistent shell session.

| Parameter    | Type    | Required | Description                                                                 |
| ------------ | ------- | -------- | --------------------------------------------------------------------------- |
| `command`    | string  | No       | Shell command to run. Mutually exclusive with `command_id`.                 |
| `timeout`    | number  | No       | Timeout in seconds (default: 120).                                          |
| `background` | boolean | No       | If true, run in background and return an ID to check later.                 |
| `command_id` | string  | No       | Check on a background command by its ID. Mutually exclusive with `command`. |

Environment variables, aliases, and cwd changes persist between calls within a session.

**Requires approval.**

---

### `run_tests`

Run the project test suite with auto-detection of the test runner.

| Parameter | Type   | Required | Description                                                                                       |
| --------- | ------ | -------- | ------------------------------------------------------------------------------------------------- |
| `command` | string | No       | Explicit test command (e.g. `"pytest -k myfunc"`). Omit to auto-detect from project config files. |
| `file`    | string | No       | Relative path to a single test file. Appended to the detected or provided command.                |

Auto-detects: `npm test`, `pytest`, `cargo test`, `go test ./...`, `./gradlew test`.

**Requires approval.**

---

### `get_diagnostics`

Fetch compiler errors, warnings, and lint issues from VS Code's language services.

| Parameter | Type   | Required | Description                                                                 |
| --------- | ------ | -------- | --------------------------------------------------------------------------- |
| `path`    | string | No       | Relative file path. Omit for a project-wide summary (capped at 100 issues). |

Also runs SideCar's security scanner for the given file. The result is authoritative — "No diagnostics" means the change is clean.

---

### `system_monitor`

Report current system resource usage: CPU load, RAM, and VRAM.

| Parameter     | Type    | Required | Description                                                                                   |
| ------------- | ------- | -------- | --------------------------------------------------------------------------------------------- |
| `include_gpu` | boolean | No       | Whether to probe GPU/VRAM metrics (default: true). Set false for a faster CPU/RAM-only check. |

Supports NVIDIA (nvidia-smi), AMD (rocm-smi), and Apple Silicon (powermetrics). Read-only, no side effects.

---

## Git

### `git_diff`

Show the git diff for the current workspace.

| Parameter | Type   | Required | Description                                                                      |
| --------- | ------ | -------- | -------------------------------------------------------------------------------- |
| `ref1`    | string | No       | First ref (e.g. `"HEAD~3"`, `"main"`, a commit SHA). Omit for working tree diff. |
| `ref2`    | string | No       | Second ref to compare against `ref1`.                                            |

---

### `git_status`

Show the working tree status: staged, modified, and untracked files. No parameters.

---

### `git_stage`

Stage files for the next commit.

| Parameter | Type     | Required | Description                                                                |
| --------- | -------- | -------- | -------------------------------------------------------------------------- |
| `files`   | string[] | No       | Files to stage (relative paths). Omit to stage all modified and new files. |

**Requires approval.**

---

### `git_commit`

Create a git commit from the currently staged changes. Appends a `Co-Authored-By` trailer for SideCar.

| Parameter | Type   | Required | Description                                                                                                                                  |
| --------- | ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `message` | string | Yes      | Commit message in conventional-commits format. In Audit Mode, the commit is queued and executes only when the user accepts the audit buffer. |

**Requires approval.**

---

### `git_log`

Show recent commit history (hash, message, author, date).

| Parameter | Type   | Required | Description                                        |
| --------- | ------ | -------- | -------------------------------------------------- |
| `count`   | number | No       | Number of commits to show (default: 10, max: 200). |

---

### `git_push`

Push local commits on the current branch to the remote.

| Parameter     | Type    | Required | Description                                                                             |
| ------------- | ------- | -------- | --------------------------------------------------------------------------------------- |
| `setUpstream` | boolean | No       | If true, sets the upstream tracking branch for a newly-created branch (default: false). |

Checks branch protection rules before pushing when `sidecar.branchProtection.enabled` is true.

**Requires approval.**

---

### `git_pull`

Pull changes from the remote on the current branch.

| Parameter | Type    | Required | Description                                                  |
| --------- | ------- | -------- | ------------------------------------------------------------ |
| `rebase`  | boolean | No       | If true, pull with rebase instead of merge (default: false). |

**Requires approval.**

---

### `git_branch`

Manage git branches: list, create, or switch.

| Parameter | Type                                 | Required | Description                                      |
| --------- | ------------------------------------ | -------- | ------------------------------------------------ |
| `action`  | `"list"` \| `"create"` \| `"switch"` | No       | Action to perform (default: `"list"`).           |
| `name`    | string                               | No       | Branch name. Required for `create` and `switch`. |

**Requires approval.**

---

### `git_stash`

Stash or restore working-tree changes.

| Parameter | Type                                                     | Required | Description                                        |
| --------- | -------------------------------------------------------- | -------- | -------------------------------------------------- |
| `action`  | `"push"` \| `"pop"` \| `"apply"` \| `"list"` \| `"drop"` | No       | Action to perform (default: `"push"`).             |
| `message` | string                                                   | No       | Optional message for a `push` stash.               |
| `index`   | number                                                   | No       | Stash index for `pop`/`apply`/`drop` (default: 0). |

**Requires approval.**

---

### `git_search_history`

Semantically search git history to find when something was introduced, changed, or removed.

| Parameter     | Type                                   | Required | Description                                                                                                                     |
| ------------- | -------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `query`       | string                                 | Yes      | The search term — keyword, symbol name, feature name, or phrase.                                                                |
| `search_type` | `"message"` \| `"content"` \| `"both"` | No       | `message` searches commit messages. `content` uses pickaxe to search code changes. `both` runs both and deduplicates (default). |
| `max_results` | number                                 | No       | Maximum commits to return per search type (default: 20, max: 100).                                                              |
| `path`        | string                                 | No       | Optional file or directory to restrict the search scope.                                                                        |

---

## GitHub

### `reply_pr_comment`

Post a reply to a specific inline PR review comment thread on GitHub.

| Parameter    | Type   | Required | Description                                       |
| ------------ | ------ | -------- | ------------------------------------------------- |
| `pr_number`  | number | Yes      | Pull request number.                              |
| `comment_id` | number | Yes      | ID of the root comment in the thread to reply to. |
| `body`       | string | Yes      | Reply text in markdown.                           |

Owner and repo are derived from the git remote automatically.

**Requires approval.**

---

### `submit_pr_review`

Submit a top-level PR review summary on GitHub.

| Parameter   | Type                                              | Required | Description                               |
| ----------- | ------------------------------------------------- | -------- | ----------------------------------------- |
| `pr_number` | number                                            | Yes      | Pull request number.                      |
| `body`      | string                                            | Yes      | Review summary in markdown.               |
| `event`     | `"COMMENT"` \| `"APPROVE"` \| `"REQUEST_CHANGES"` | No       | Review event type (default: `"COMMENT"`). |

**Requires approval.**

---

### `create_pr_review`

Submit a GitHub PR review with inline file-level comments and an optional top-level summary — in one API call.

| Parameter   | Type                                              | Required | Description                                                                                                  |
| ----------- | ------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `pr_number` | number                                            | Yes      | Pull request number.                                                                                         |
| `body`      | string                                            | Yes      | Top-level review summary in markdown (may be empty string).                                                  |
| `event`     | `"COMMENT"` \| `"APPROVE"` \| `"REQUEST_CHANGES"` | No       | Review event type (default: `"COMMENT"`).                                                                    |
| `comments`  | object[]                                          | No       | Array of inline comments. Each item: `{ path: string, line: number, body: string, side?: "LEFT"\|"RIGHT" }`. |

**Requires approval.**

---

### `mark_pr_ready`

Convert the draft pull request for the current branch to ready-for-review on GitHub. No parameters.

**Requires approval.**

---

### `check_pr_ci`

Fetch and display the CI check-run status for the pull request on the current branch. No parameters.

Returns a markdown table of all checks with status and conclusion.

---

## Web & Search

### `web_search`

Search the web and return titles, URLs, and snippets.

| Parameter | Type   | Required | Description                                                                |
| --------- | ------ | -------- | -------------------------------------------------------------------------- |
| `query`   | string | Yes      | Search query. Queries containing credential-shaped substrings are blocked. |

Configured via `sidecar.webSearch.provider` and `sidecar.webSearch.apiKey`.

---

### `display_diagram`

Extract a diagram code block (mermaid, graphviz, plantuml, dot) from a markdown file for rendering in chat.

| Parameter | Type   | Required | Description                                                                   |
| --------- | ------ | -------- | ----------------------------------------------------------------------------- |
| `path`    | string | Yes      | Relative path to the markdown file containing diagrams.                       |
| `index`   | number | No       | Zero-based index of the diagram when the file contains multiple (default: 0). |

---

### `render_viz`

Render a visualization spec (chart, table, timeline, or heatmap) inline in the chat. Use when structured data is clearer shown than described — not for plain text responses.

| Parameter | Type     | Required | Description                                                                               |
| --------- | -------- | -------- | ----------------------------------------------------------------------------------------- |
| `type`    | string   | Yes      | One of `chart`, `table`, `timeline`, `heatmap`.                                           |
| `data`    | array    | Yes      | Data points or objects. For charts: an array of numbers. For tables: an array of objects. |
| `labels`  | string[] | Yes      | Labels per dimension (bar names for a chart, column headers for a table).                 |
| `title`   | string   | No       | Optional title for the visualization.                                                     |

---

### `search_files`

Search for files matching a glob pattern in the workspace.

| Parameter | Type   | Required | Description                                            |
| --------- | ------ | -------- | ------------------------------------------------------ |
| `pattern` | string | Yes      | Glob pattern (e.g. `"**/*.ts"`, `"src/**/*.test.js"`). |

Returns up to 200 matching paths, excluding `node_modules`, `.git`, `dist`, and similar directories.

---

### `grep`

Search file contents for a text pattern (string or regex).

| Parameter | Type   | Required | Description                             |
| --------- | ------ | -------- | --------------------------------------- |
| `pattern` | string | Yes      | Text or regex pattern to search for.    |
| `path`    | string | No       | Limit search to this file or directory. |

Returns matching lines with file paths and line numbers. Output is capped and grouped by file.

---

### `find_references`

Find every reference to a symbol across the workspace using the tree-sitter symbol graph.

| Parameter | Type   | Required | Description                                                                  |
| --------- | ------ | -------- | ---------------------------------------------------------------------------- |
| `symbol`  | string | Yes      | Name of the symbol to find references for (function, class, type, variable). |
| `file`    | string | No       | Restrict to references involving this file or directory.                     |

Returns: definition location, files importing the defining module, and all usage sites. Requires the workspace symbol graph to be indexed (built at activation).

---

### `project_knowledge_search`

Semantic search over symbols (functions, classes, methods, interfaces, types) in the workspace.

| Parameter        | Type     | Required | Description                                                                                                      |
| ---------------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `query`          | string   | Yes      | Natural-language description of what you are looking for.                                                        |
| `maxHits`        | number   | No       | Max results to return (default: 10, max: 50).                                                                    |
| `kindFilter`     | string[] | No       | Filter by symbol kind, e.g. `["function", "class"]`.                                                             |
| `pathPrefix`     | string   | No       | Restrict to a subdirectory, e.g. `"src/middleware/"`.                                                            |
| `graphWalkDepth` | number   | No       | Number of `calls` edges to walk from each vector hit (default: 1, max: 3). Set to 0 to disable graph enrichment. |
| `maxGraphHits`   | number   | No       | Cap on symbols added via graph walk (default: 10, max: 50).                                                      |

Requires `sidecar.projectKnowledge.enabled: true`. Returns a "not available" message while the index warms up.

---

## Code Graph & Numerical

Consequence-aware queries over the symbol graph's call/type-flow edges, plus shape/dtype contract checking for scientific code. Always available; the matching completion gates (`sidecar.codeGraph.impactGate`, `sidecar.numericalContracts.gate`) are opt-in.

### `analyze_impact`

Change-impact analysis: given the symbols (or a file) you are about to change, returns what depends on them — transitive callers, symbols that use them as a type, subtypes, and importing files. Complements `project_knowledge_search` ("where is X?") by answering "what depends on X?". Import-resolved (same-named symbols elsewhere are excluded) but advisory — treat results as "review these", not a proof of breakage.

| Parameter  | Type     | Required | Description                                                                       |
| ---------- | -------- | -------- | --------------------------------------------------------------------------------- |
| `symbols`  | string[] | No       | Names of the changed symbols (functions / classes / interfaces / types).          |
| `file`     | string   | No       | Relative path of a changed file — analyzes the impact of every symbol it defines. |
| `maxDepth` | number   | No       | How many caller hops to walk transitively (1–3). Default: 2.                      |

Pass `symbols` or `file` (at least one). Example: `analyze_impact(symbols=["requireAuth"])` or `analyze_impact(file="src/auth.ts")`.

---

### `query_code_graph`

Query the code graph for how a symbol relates to the codebase — `callers` (who calls it), `callees` (what it calls), `references` (all mentions), `type-users` (symbols using this type), or `neighborhood` (combined summary). Complements `analyze_impact` (downstream blast radius) with the exploratory both-directions view. Always available (read-only).

| Parameter  | Type   | Required | Description                                                                                       |
| ---------- | ------ | -------- | ------------------------------------------------------------------------------------------------- |
| `symbol`   | string | Yes      | Name of the symbol to inspect (function / class / interface / type).                              |
| `relation` | string | No       | One of `callers`, `callees`, `references`, `type-users`, `neighborhood`. Default: `neighborhood`. |

Example: `query_code_graph(symbol="requireAuth", relation="callers")` or `query_code_graph(symbol="ChatMessage", relation="type-users")`.

---

### `check_numerical_contracts`

List numerical kernels (functions with array/tensor/quantity parameters or returns — e.g. `np.ndarray`) and flag those lacking a shape/dtype/unit contract (a shaped type annotation, a shape/dtype assertion, or a docstring shape spec). Use after editing scientific code to confirm the array contracts are stated, not just that tests pass.

| Parameter          | Type    | Required | Description                                                                    |
| ------------------ | ------- | -------- | ------------------------------------------------------------------------------ |
| `file`             | string  | No       | Relative path to scope the scan to a single file (omit to scan the workspace). |
| `onlyUncontracted` | boolean | No       | List only kernels missing a contract. Default: false.                          |

---

### `check_shape_consistency`

Check that the shape/dtype contracts on numerical functions are internally consistent — a parameter whose type annotation and `assert x.shape == …` disagree, or `def f(...): return g(...)` where `f` and `g` declare different return shapes. Symbolic dims (`N`) are wildcards, so only provable conflicts (rank, conflicting literal dims, dtype) are reported.

| Parameter | Type   | Required | Description                                        |
| --------- | ------ | -------- | -------------------------------------------------- |
| `file`    | string | No       | Relative path to scope the check to a single file. |

---

## Databases

Requires connections configured under `sidecar.databases.profiles`.

### `db_list_connections`

List all configured database connections and their current status. No parameters.

Returns each connection's name, dialect, host/file, and read-only flag. Call this first to discover valid `connection_id` values.

---

### `db_list_tables`

List all tables in a connected database.

| Parameter       | Type   | Required | Description                                                                            |
| --------------- | ------ | -------- | -------------------------------------------------------------------------------------- |
| `connection_id` | string | Yes      | Connection ID from `db_list_connections`.                                              |
| `schema`        | string | No       | Schema/namespace to filter (defaults to `"public"` for Postgres, `"main"` for DuckDB). |

---

### `db_describe_table`

Describe the schema of a specific table: columns, indexes, and constraints.

| Parameter       | Type   | Required | Description                               |
| --------------- | ------ | -------- | ----------------------------------------- |
| `connection_id` | string | Yes      | Connection ID from `db_list_connections`. |
| `table`         | string | Yes      | Table name to describe.                   |
| `schema`        | string | No       | Schema/namespace (optional).              |

---

### `db_query`

Run a read-only parameterized SQL query against a database connection.

| Parameter       | Type   | Required | Description                                                                                                 |
| --------------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------- |
| `connection_id` | string | Yes      | Connection ID from `db_list_connections`.                                                                   |
| `sql`           | string | Yes      | SQL query. Only SELECT and other read-only statements are permitted — INSERT/UPDATE/DELETE/DDL are blocked. |
| `params`        | any[]  | No       | Bind parameters (positional). Use `$1`/`$2` for Postgres/DuckDB, `?` for MySQL/SQLite.                      |
| `limit`         | number | No       | Maximum rows to return (default: `sidecar.databases.queryRowLimit`, default 10000).                         |
| `timeout_ms`    | number | No       | Query timeout in milliseconds (default: `sidecar.databases.queryTimeoutMs`, default 30000).                 |

Results are rendered as a sortable table in the chat panel.

---

### `db_execute`

Execute a write SQL statement (INSERT, UPDATE, DELETE, DDL) on a database connection.

| Parameter       | Type   | Required | Description                                                 |
| --------------- | ------ | -------- | ----------------------------------------------------------- |
| `connection_id` | string | Yes      | Connection ID (must have `readOnly: false` in the profile). |
| `sql`           | string | Yes      | SQL statement to execute.                                   |
| `params`        | any[]  | No       | Bind parameters (positional).                               |

In Audit Mode, the statement is buffered at `.sidecar/audit/db/<connectionId>/<timestamp>.sql` for review.

**Requires approval.**

---

### `db_migrate_up`

Run database migrations to the latest version.

| Parameter        | Type                                                                 | Required | Description                                                                       |
| ---------------- | -------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------- |
| `connection_id`  | string                                                               | Yes      | Connection ID from `db_list_connections`.                                         |
| `tool`           | `"prisma"` \| `"alembic"` \| `"flyway"` \| `"drizzle"` \| `"custom"` | No       | Migration tool to use (default: `"prisma"`).                                      |
| `migration_dir`  | string                                                               | No       | Path to the migration directory relative to workspace root (default: `"prisma"`). |
| `custom_command` | string                                                               | No       | Full migration command when `tool="custom"`.                                      |
| `dry_run`        | boolean                                                              | No       | If true, shows the command that would run without executing it (default: false).  |

**Requires approval.**

---

## Vision & Browser

Requires `sidecar.visualVerify.enabled: true`. `screenshot_page` and `run_playwright_code` additionally require `playwright-core` to be installed in the extension host environment.

### `screenshot_page`

Capture a screenshot of a URL using a headless Chromium browser. Saves PNG to `.sidecar/screenshots/`.

| Parameter  | Type   | Required | Description                                                                                                                                  |
| ---------- | ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`      | string | Yes      | URL to capture (`http://` or `https://`). Loopback and private-range URLs are blocked unless added to `sidecar.visualVerify.allowedDomains`. |
| `selector` | string | No       | CSS selector — screenshots only the matching element instead of the full viewport.                                                           |
| `wait_for` | string | No       | Readiness condition: `"load"` (default), `"networkidle"`, `"domcontentloaded"`, `"selector:<css>"`, or a number of milliseconds.             |
| `viewport` | object | No       | Viewport size: `{ width: number, height: number }` (default: 1280×800, max: 2048×1440).                                                      |

Rate limit: 20 calls/minute.

---

### `analyze_screenshot`

Analyze a screenshot against stated visual criteria using a vision-capable model.

| Parameter    | Type   | Required | Description                                                                                  |
| ------------ | ------ | -------- | -------------------------------------------------------------------------------------------- |
| `image_path` | string | Yes      | Workspace-relative path to the image file (e.g. `".sidecar/screenshots/file.png"`).          |
| `criteria`   | string | Yes      | Human-readable description of what the image should show (success criteria). Max 2000 chars. |
| `model`      | string | No       | Optional vision model override. Defaults to `sidecar.visualVerify.vlm` or the active model.  |

Runs a cheap heuristic pre-filter (blank canvas, edge clipping) before calling the VLM. Returns `{ pass: boolean, confidence: number, issues: string[] }`. Requires a vision-capable model (Claude 3+, GPT-4o, llava, etc.).

Rate limit: 10 calls/minute.

---

### `open_in_browser`

Open a URL in VS Code's built-in Simple Browser panel.

| Parameter | Type   | Required | Description                            |
| --------- | ------ | -------- | -------------------------------------- |
| `url`     | string | Yes      | URL to open (`http://` or `https://`). |

Falls back to the system browser if Simple Browser is unavailable.

---

### `run_playwright_code`

Execute a Playwright TypeScript script for complex browser interactions.

| Parameter    | Type   | Required | Description                                                                       |
| ------------ | ------ | -------- | --------------------------------------------------------------------------------- |
| `script`     | string | Yes      | Playwright TypeScript script to execute. `playwright-core` imports are available. |
| `timeout_ms` | number | No       | Script execution timeout in milliseconds (default: 30000, max: 120000).           |

Runs in a Node.js child process. Requires workspace trust. Only safe environment variables are forwarded to the child process (no API keys or credentials).

**Always requires approval — cannot be bypassed by `toolPermissions` or autonomous mode.**

---

## Agent Management

### `ask_user`

Ask the user a clarifying question with suggested options.

| Parameter      | Type     | Required | Description                                                  |
| -------------- | -------- | -------- | ------------------------------------------------------------ |
| `question`     | string   | Yes      | The question to ask the user.                                |
| `options`      | string[] | Yes      | Suggested options (max 5, keep each 1–4 words).              |
| `allow_custom` | boolean  | No       | Whether the user can type a custom response (default: true). |

Only for genuinely ambiguous requests where alternatives have meaningfully different outcomes.

---

### `describe_tool`

Return the full schema and parameter documentation for any registered tool.

| Parameter | Type   | Required | Description                         |
| --------- | ------ | -------- | ----------------------------------- |
| `name`    | string | Yes      | Exact name of the tool to describe. |

Many domain-specific tools are presented as compact one-line stubs in the prompt to save context. Call `describe_tool(name='...')` to fetch the full parameter list before using those tools.

---

### `query_history`

Run a read-only `SELECT` against the local eval-history database — useful for the agent to reason about its own past performance. Tables: `eval_runs(id, timestamp, model, case_id, passed, duration_ms, iterations, failures, tags)` and `eval_baselines(model, case_id, pass_rate, last_passed, run_count, last_updated)`. Only `SELECT` is accepted; rows return as JSON.

| Parameter | Type   | Required | Description                                               |
| --------- | ------ | -------- | --------------------------------------------------------- |
| `sql`     | string | Yes      | A `SELECT` query against `eval_runs` or `eval_baselines`. |

---

### `spawn_agent`

Spawn a sub-agent to handle a specific, self-contained task in parallel.

| Parameter | Type   | Required | Description                                                                |
| --------- | ------ | -------- | -------------------------------------------------------------------------- |
| `task`    | string | Yes      | Clear, self-contained description of what the sub-agent should accomplish. |
| `context` | string | No       | Additional context, file contents, or constraints the sub-agent needs.     |

Sub-agents have access to all tools but run with a reduced iteration limit (max 15). Sub-agents cannot spawn further sub-agents beyond 3 levels deep.

---

### `delegate_task`

Offload a focused, read-only research task to a local Ollama worker model.

| Parameter | Type   | Required | Description                                                              |
| --------- | ------ | -------- | ------------------------------------------------------------------------ |
| `task`    | string | Yes      | Clear, self-contained description of what the worker should investigate. |
| `context` | string | No       | Additional context from prior turns.                                     |

Only advertised to the model when the active backend is Anthropic or OpenAI (paid per token). The worker runs on a separate SideCarClient instance pointed at `localhost:11434` with a read-only tool subset. Token usage does not count against the frontier model's bill.

Requires `sidecar.delegateTask.enabled: true`.

---

### `switch_backend`

Switch SideCar to a different built-in backend profile.

| Parameter | Type                                                             | Required | Description                   |
| --------- | ---------------------------------------------------------------- | -------- | ----------------------------- |
| `profile` | `"local-ollama"` \| `"anthropic"` \| `"openai"` \| `"kickstand"` | Yes      | Backend profile to switch to. |

If the target profile has no stored API key, the tool reports that so the user can run "SideCar: Set API Key".

**Always requires approval.**

---

### `get_setting`

Read the current value of a SideCar configuration setting.

| Parameter | Type   | Required | Description                                                                                          |
| --------- | ------ | -------- | ---------------------------------------------------------------------------------------------------- |
| `key`     | string | Yes      | Setting key without the `"sidecar."` prefix. Dotted namespaces allowed (e.g. `"jsDocSync.enabled"`). |

API keys (`apiKey`, `fallbackApiKey`) are blocked. Only `sidecar.*` keys are exposed.

---

### `update_setting`

Update a SideCar configuration setting at user (global) scope.

| Parameter | Type   | Required | Description                                  |
| --------- | ------ | -------- | -------------------------------------------- |
| `key`     | string | Yes      | Setting key without the `"sidecar."` prefix. |
| `value`   | any    | Yes      | New value. Pass `null` to clear a setting.   |

Security-sensitive keys are permanently blocked regardless of approval: API keys, tool permissions, custom tools/modes, MCP server definitions, event hooks, scheduled tasks, system prompt override, outbound allowlist, backend URLs, and context path lists.

**Always requires approval.**

---

## PDF & Literature

### `read_pdf`

Extract and return the text content of a PDF file.

| Parameter | Type   | Required | Description                                            |
| --------- | ------ | -------- | ------------------------------------------------------ |
| `path`    | string | Yes      | Path to the PDF file (workspace-relative or absolute). |

Returns up to 8,000 characters. For longer PDFs, use `index_pdf` first, then search with `project_knowledge_search`.

---

### `index_pdf`

Chunk and index a PDF file into `.sidecar/literature/` for later retrieval.

| Parameter | Type   | Required | Description                                            |
| --------- | ------ | -------- | ------------------------------------------------------ |
| `path`    | string | Yes      | Path to the PDF file (workspace-relative or absolute). |

Run once per PDF before trying to search it. Chunks are content-addressed by SHA-256.

---

### `zotero_search`

Search the user's Zotero reference library by keyword.

| Parameter | Type   | Required | Description                                    |
| --------- | ------ | -------- | ---------------------------------------------- |
| `query`   | string | Yes      | Keyword search query.                          |
| `limit`   | number | No       | Maximum number of results (1–25, default: 10). |

Requires `sidecar.zotero.userId` and `sidecar.zotero.apiKey` to be set.

---

### `zotero_get_item`

Retrieve full bibliographic details for a single Zotero library item.

| Parameter | Type   | Required | Description                                                    |
| --------- | ------ | -------- | -------------------------------------------------------------- |
| `key`     | string | Yes      | Zotero item key (8-character alphanumeric, e.g. `"ABCD1234"`). |

Returns title, authors, year, publication, DOI, URL, tags, and full abstract. Requires Zotero credentials.

---

### `insert_citation`

Fetch a Zotero item and return it formatted as APA, MLA, Chicago, BibTeX, or LaTeX.

| Parameter | Type                                                         | Required | Description                                                                                                       |
| --------- | ------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `key`     | string                                                       | Yes      | Zotero item key.                                                                                                  |
| `style`   | `"apa"` \| `"mla"` \| `"chicago"` \| `"bibtex"` \| `"latex"` | No       | Citation style. Auto-detected from `file` extension when omitted (`.bib` → BibTeX, `.tex` → LaTeX, default: APA). |
| `file`    | string                                                       | No       | Target file path used for style auto-detection.                                                                   |

Requires Zotero credentials.

---

## Doc-to-Test

Requires `sidecar.docTests.enabled: true`.

### `extract_constraints`

Parse a reference document and extract all verifiable constraints into a structured JSON manifest.

| Parameter      | Type   | Required | Description                                                                                                            |
| -------------- | ------ | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `doc_path`     | string | Yes      | Path to the document (absolute or relative to workspace root). Supports `.md`, `.tex`, `.rst`, `.pdf`, and plain text. |
| `section_hint` | string | No       | Heading or section name to focus extraction on. Useful for large documents.                                            |

Each constraint is typed (`mathematical_identity`, `numeric_example`, `boundary_condition`, `complexity_bound`, `invariant`, or `qualitative_claim`) and includes a provenance string quoting the exact source sentence. Returns `{ constraints: Constraint[], docSlug, truncated }`.

---

### `synthesize_tests`

Generate a complete pytest test file from a Constraint[] manifest.

| Parameter      | Type   | Required | Description                                                                                                      |
| -------------- | ------ | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `constraints`  | string | Yes      | JSON string — either a `Constraint[]` array or the full `ConstraintExtractionResult` from `extract_constraints`. |
| `doc_slug`     | string | Yes      | Short identifier for the document (used in output file path and test module name).                               |
| `impl_context` | string | No       | File paths or description of the implementation being tested (helps pick import paths).                          |

Filters to approved (`approved !== false`) and testable constraints. Returns the generated Python source — use `write_file` to save it, then run with `pytest`.

---

### `classify_test_failure`

Classify a failing pytest test back to its root cause.

| Parameter      | Type   | Required | Description                                                                        |
| -------------- | ------ | -------- | ---------------------------------------------------------------------------------- |
| `test_output`  | string | Yes      | The pytest output for a single failing test (the FAILED block from `pytest -v`).   |
| `constraint`   | string | Yes      | JSON string of the `Constraint` object that the failing test was synthesized from. |
| `impl_snippet` | string | No       | Relevant implementation code block. Improves classification accuracy.              |

Returns `{ verdict: "impl_wrong" | "doc_wrong" | "extraction_wrong", reasoning, proposed_fix }`.

---

### `mutation_test`

Mutation testing — seed single-point faults into a source file and report which mutants SURVIVE the test suite (proof the tests would miss that class of bug). Opt-in via `sidecar.mutation.enabled`; requires a green baseline.

| Parameter      | Type     | Required | Description                                                                                        |
| -------------- | -------- | -------- | -------------------------------------------------------------------------------------------------- |
| `file`         | string   | Yes      | Source file to mutate (relative to the workspace root, or absolute).                               |
| `test_command` | string   | Yes      | Command that runs the tests covering `file`. Must exit 0 on the unmodified file.                   |
| `operators`    | string[] | No       | Mutation operator classes: `relational`, `arithmetic`, `logical`, `boolean-literal`. Default: all. |
| `max_mutants`  | number   | No       | Cap on mutants generated/tested (bounds runtime). Defaults to `sidecar.mutation.maxMutants`.       |

---

### `synthesize_property_test`

Property-based test synthesis (§5 numerical vertical) — generate a runnable Hypothesis property test for a numerical kernel that declares invariants (`# property: symmetric` / `idempotent` / `monotonic` / `non-negative`, `# bounds: 0 <= result <= 1`, `# invariant: sum(result) == sum(x)`). Emits random-input strategies + the declared assertions. Always available (read-only).

| Parameter      | Type   | Required | Description                                             |
| -------------- | ------ | -------- | ------------------------------------------------------- |
| `file`         | string | Yes      | Relative path to the source file containing the kernel. |
| `function`     | string | Yes      | Name of the function to synthesize a property test for. |
| `max_examples` | number | No       | Hypothesis `max_examples` (default 100).                |

---

### `update_plan`

Create or update the agent's externalized step-by-step plan for the current task (added v0.119, gated by `sidecar.plan.externalized`, default off). The harness re-shows the plan every turn so it survives long tasks and compaction; an `update_plan`-only turn does not consume the iteration budget.

| Parameter     | Type     | Required | Description                                                               |
| ------------- | -------- | -------- | ------------------------------------------------------------------------- |
| `steps`       | string[] | Yes      | The COMPLETE ordered list of steps (restated in full every call).         |
| `current`     | number   | No       | 1-based index of the step being worked on now. Default 1.                 |
| `last_result` | string   | No       | One line: the outcome of the step just finished (omit on the first call). |

---

## Notebook Mode

Requires `sidecar.notebookMode.enabled: true`.

### `ingest_source`

Index a web URL or local file as a named research source for Notebook Mode.

| Parameter | Type   | Required | Description                                                                                          |
| --------- | ------ | -------- | ---------------------------------------------------------------------------------------------------- |
| `source`  | string | Yes      | A web URL (`https://...`) or absolute/relative file path to index.                                   |
| `label`   | string | No       | Short label for this source (e.g. `"attention-paper"`). Auto-generated from URL/filename if omitted. |

Web URLs are fetched and stripped of navigation/ads. Returns the assigned source ID for use with `generate_*` tools. Loopback and private-range URLs are blocked.

---

### `generate_briefing`

Generate a multi-section briefing document from indexed research sources.

| Parameter    | Type   | Required | Description                                                    |
| ------------ | ------ | -------- | -------------------------------------------------------------- |
| `source_ids` | string | Yes      | Comma-separated source IDs, or `"*"` for all ingested sources. |
| `project`    | string | No       | Project name for output directory (default: `"default"`).      |

Sections: Executive Summary, Key Findings, Methodology, Limitations, Open Questions. Writes to `.sidecar/research/<project>/generated/briefing.md`.

Also requires `sidecar.notebookMode.studyAids.enabled`.

---

### `generate_study_guide`

Generate progressive Q&A pairs from indexed sources at four depth levels.

| Parameter    | Type                                                                           | Required | Description                                  |
| ------------ | ------------------------------------------------------------------------------ | -------- | -------------------------------------------- |
| `source_ids` | string                                                                         | Yes      | Comma-separated source IDs or `"*"`.         |
| `project`    | string                                                                         | No       | Project name (default: `"default"`).         |
| `depth`      | `"recall"` \| `"comprehension"` \| `"application"` \| `"synthesis"` \| `"all"` | No       | Depth levels to generate (default: `"all"`). |

Writes to `.sidecar/research/<project>/generated/study_guide.md`. Requires `sidecar.notebookMode.studyAids.enabled`.

---

### `generate_faq`

Generate a FAQ document with cited answers from indexed sources.

| Parameter    | Type   | Required | Description                                            |
| ------------ | ------ | -------- | ------------------------------------------------------ |
| `source_ids` | string | Yes      | Comma-separated source IDs or `"*"`.                   |
| `project`    | string | No       | Project name (default: `"default"`).                   |
| `count`      | number | No       | Number of FAQs to generate (default: 10, range: 3–30). |

Writes to `.sidecar/research/<project>/generated/faq.md`. Requires `sidecar.notebookMode.studyAids.enabled`.

---

### `generate_timeline`

Extract dated events, milestones, and entities into a chronological timeline.

| Parameter    | Type   | Required | Description                          |
| ------------ | ------ | -------- | ------------------------------------ |
| `source_ids` | string | Yes      | Comma-separated source IDs or `"*"`. |
| `project`    | string | No       | Project name (default: `"default"`). |

Writes to `.sidecar/research/<project>/generated/timeline.md`. Requires `sidecar.notebookMode.studyAids.enabled`.

---

### `generate_outline`

Generate a hierarchical topic outline with per-node source attribution.

| Parameter    | Type   | Required | Description                          |
| ------------ | ------ | -------- | ------------------------------------ |
| `source_ids` | string | Yes      | Comma-separated source IDs or `"*"`. |
| `project`    | string | No       | Project name (default: `"default"`). |
| `depth`      | number | No       | Outline depth 1–4 (default: 3).      |

Writes to `.sidecar/research/<project>/generated/outline.md`. Requires `sidecar.notebookMode.studyAids.enabled`.

---

## Research Assistant

Requires `sidecar.research.enabled: true`. Projects are stored under `.sidecar/research/<slug>/`.

### `research_create_project`

Create a new research project.

| Parameter  | Type   | Required | Description                                              |
| ---------- | ------ | -------- | -------------------------------------------------------- |
| `title`    | string | Yes      | Short project title (used to derive the directory slug). |
| `question` | string | Yes      | The central research question this project addresses.    |

Initializes `project.yaml` with the title, question, empty hypotheses list, and status `"active"`. Returns the project slug.

---

### `research_add_hypothesis`

Add a hypothesis to an existing research project.

| Parameter    | Type   | Required | Description                      |
| ------------ | ------ | -------- | -------------------------------- |
| `project`    | string | Yes      | Project slug.                    |
| `hypothesis` | string | Yes      | The hypothesis statement to add. |

Appends to the hypotheses array with status `"open"`. Returns the hypothesis ID.

---

### `research_log_experiment`

Record and run an experiment for a research project.

| Parameter    | Type   | Required | Description                                                                           |
| ------------ | ------ | -------- | ------------------------------------------------------------------------------------- |
| `project`    | string | Yes      | Project slug.                                                                         |
| `id`         | string | Yes      | Unique experiment identifier (e.g. `"exp-2026-05-fft-baseline"`).                     |
| `command`    | string | Yes      | Shell command to run the experiment.                                                  |
| `parameters` | object | No       | Key/value parameters for reproducibility (logged to manifest, not passed to command). |
| `seed`       | number | No       | Random seed for reproducibility.                                                      |

Writes `experiments/<id>/manifest.yaml`, executes the command, and captures the result (last 30 lines of output, max 2000 chars).

**Requires approval.**

---

### `research_add_observation`

Append a timestamped observation note to a research project.

| Parameter | Type   | Required | Description                     |
| --------- | ------ | -------- | ------------------------------- |
| `project` | string | Yes      | Project slug.                   |
| `note`    | string | Yes      | The observation text to record. |

Saved to `observations/<timestamp>.md`.

---

### `research_update_hypothesis_status`

Update the status of a hypothesis.

| Parameter | Type                                                                                 | Required | Description                                            |
| --------- | ------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------ |
| `project` | string                                                                               | Yes      | Project slug.                                          |
| `id`      | string                                                                               | Yes      | Hypothesis ID (returned by `research_add_hypothesis`). |
| `status`  | `"open"` \| `"supported"` \| `"refuted"` \| `"needs-more-evidence"` \| `"abandoned"` | Yes      | New status.                                            |

---

### `research_list_projects`

List all research projects and their summary stats. No parameters.

Returns project slugs, titles, status, hypothesis count, and last updated time.

---

### `research_set_project_status`

Update the status of a research project.

| Parameter | Type                                                      | Required | Description         |
| --------- | --------------------------------------------------------- | -------- | ------------------- |
| `project` | string                                                    | Yes      | Project slug.       |
| `status`  | `"active"` \| `"paused"` \| `"complete"` \| `"abandoned"` | Yes      | New project status. |

---

### `research_export_report`

Generate a structured markdown report for a research project.

| Parameter | Type   | Required | Description   |
| --------- | ------ | -------- | ------------- |
| `project` | string | Yes      | Project slug. |

Includes hypothesis outcomes table, experiment results with output tails, and observations timeline. Writes to `.sidecar/research/<slug>/report.md` and returns the full markdown.

---

## CI & Profiling

### `check_dependencies`

Scan package manifests for outdated dependencies and known vulnerabilities.

| Parameter              | Type                                       | Required | Description                                                                                           |
| ---------------------- | ------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------- |
| `ecosystem`            | `"npm"` \| `"pypi"` \| `"cargo"` \| `"go"` | No       | Restrict to a single package manager. Omit to scan all detected manifests.                            |
| `checkVulnerabilities` | boolean                                    | No       | Whether to query OSV for known vulnerabilities (default: true). Set false for a faster offline check. |

Scans `package.json`, `requirements.txt`, `Cargo.toml`, and `go.mod`. Vulnerable packages are flagged with CVE/GHSA IDs and severity. Results are also surfaced passively in the VS Code Problems panel when `sidecar.deps.enabled` is true.

Requires `sidecar.deps.enabled: true`.

---

### `analyze_ci_failure`

Fetch and parse the GitHub Actions log for the most recent failed CI run on the current branch.

| Parameter    | Type     | Required | Description                                                                                                                                      |
| ------------ | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `job_filter` | string[] | No       | Glob patterns matched against CI job names (case-insensitive). Defaults to `["*"]` (all failed jobs). Supports `*` wildcard (e.g. `["*test*"]`). |

Returns a structured markdown summary of failed jobs and steps, with relevant log lines trimmed to failure context (ANSI stripped, timestamps removed). Requires a GitHub token with `actions:read` scope configured via "SideCar: Set GitHub Token".

Requires `sidecar.ci.analysis.enabled: true`.

---

### `profile_code`

Profile the project code to identify CPU and memory hotspots.

| Parameter   | Type                                                     | Required | Description                                                                        |
| ----------- | -------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| `ecosystem` | `"auto"` \| `"node"` \| `"python"` \| `"go"` \| `"rust"` | No       | Project ecosystem (default: `"auto"`, detected from workspace files).              |
| `script`    | string                                                   | No       | Entry file to profile. Required for `node` and `python`; omit for `go` and `rust`. |
| `top_n`     | number                                                   | No       | Number of hotspots to return (default: `sidecar.profiling.topN`, default 10).      |

Profiler backends: Python `cProfile -s cumulative`, Go `go test -bench -benchmem`, Rust `cargo bench`, Node.js `--prof` + `--prof-process`. Returns ranked hotspot markdown plus a collapsed full profiler output block.

Requires `sidecar.profiling.enabled: true`.

**Requires approval.**

---

## LaTeX

### `latex_compile`

Compile a LaTeX document and return structured errors and warnings.

| Parameter | Type   | Required | Description                                                                                                                     |
| --------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `file`    | string | No       | Path to the main `.tex` file (relative to workspace root). Auto-detects the first `.tex` file in the workspace root if omitted. |

Prefers `latexmk` if available, falls back to `pdflatex`. Returns structured `errors[]` with file/line references, `warnings[]`, and the PDF output path on success.

Requires `sidecar.latex.enabled: true`. Compiler can be forced via `sidecar.latex.compiler`.

**Requires approval.**

---

## MCP Delegation

### `delegate_to_mcp`

Delegate a sub-task to a configured MCP server that has its own agent or reasoning loop.

| Parameter | Type   | Required | Description                                                                                                                                                  |
| --------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `server`  | string | Yes      | MCP server name as configured in `sidecar.mcpServers` (e.g. `"math-engine"`).                                                                                |
| `task`    | string | Yes      | Natural language description of the sub-task for the server to complete.                                                                                     |
| `tool`    | string | No       | Specific tool to call on the server. Auto-detected from candidates (`run_task`, `execute_task`, `task`, `run`, `execute`, `process`, `handle`) when omitted. |
| `context` | string | No       | Additional context from the current conversation to include with the task.                                                                                   |

Allowlist: if `sidecar.mcpDelegation.allowedServers` is non-empty, only listed servers are reachable.

Requires `sidecar.mcpDelegation.enabled: true`.

---

## Monorepo

### `monorepo_packages`

List all packages discovered in the monorepo. No parameters.

Returns the detected layout type (nx / turbo / pnpm / yarn / lerna) and each package name with its workspace-relative path. Pass a `relativePath` value as `pathPrefix` to `project_knowledge_search` to scope semantic symbol search to a single package.

Requires `sidecar.monorepo.enabled: true`.

---

## Kickstand

These tools manage LoRA adapters on a Kickstand-hosted model. They require the active backend to be Kickstand with a loaded model — other backends return a "not supported" error.

### `kickstand_list_loras`

List LoRA adapters currently attached to a Kickstand-hosted model.

| Parameter  | Type   | Required | Description                                |
| ---------- | ------ | -------- | ------------------------------------------ |
| `model_id` | string | Yes      | ID of the loaded Kickstand model to query. |

Returns each adapter with its `id`, `path`, and `scale`.

---

### `kickstand_attach_lora`

Attach a LoRA adapter to a loaded Kickstand model without reloading the base.

| Parameter  | Type   | Required | Description                                                     |
| ---------- | ------ | -------- | --------------------------------------------------------------- |
| `model_id` | string | Yes      | ID of the loaded Kickstand model.                               |
| `path`     | string | Yes      | Absolute path to the GGUF adapter file on the Kickstand server. |
| `scale`    | number | No       | Adapter scale (default: 1.0). Valid range: 0.0–2.0.             |

Multiple adapters can stack on one base with per-adapter scaling. The mutation is ephemeral and undoable via `kickstand_detach_lora`.

**Requires approval.**

---

### `kickstand_detach_lora`

Detach a LoRA adapter from a loaded Kickstand model.

| Parameter    | Type   | Required | Description                                                                                 |
| ------------ | ------ | -------- | ------------------------------------------------------------------------------------------- |
| `model_id`   | string | Yes      | ID of the loaded Kickstand model.                                                           |
| `adapter_id` | string | Yes      | Adapter ID returned by `kickstand_attach_lora` or visible in `kickstand_list_loras` output. |

The base model stays loaded — only the named adapter is unloaded.

**Requires approval.**
