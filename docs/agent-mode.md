---
title: Agent Mode
layout: docs
nav_order: 3
---

# Agent Mode

SideCar isn't just a chatbot — it's an autonomous coding agent. It can read your code, edit files, run tests, diagnose errors, and iterate until the task is done.

## The agent loop

When you give SideCar a task, it enters an agent loop:

1. **Read** — examines relevant files, diagnostics, and context
2. **Plan** — decides which tools to use
3. **Execute** — writes/edits files, runs commands
4. **Verify** — checks diagnostics and test results
5. **Iterate** — if something failed, goes back to step 1

The loop continues until the task is complete, the model returns a final response, or safety limits are reached.

## Approval modes

Control how much autonomy SideCar has via the agent mode dropdown in the chat header, or the `sidecar.agentMode` setting:

| Mode | Reads | Writes | Destructive |
|------|-------|--------|-------------|
| **Cautious** (default) | Auto-approve | Confirm | Confirm |
| **Autonomous** | Auto-approve | Auto-approve | Confirm |
| **Manual** | Confirm | Confirm | Confirm |
| **Review** | Auto-approve | Buffered — see below | Confirm |

- **Cautious** is recommended for most use. File reads happen automatically; writes and edits open a **VS Code diff editor** showing the proposed changes. Accept/Reject buttons appear both as a VS Code notification (in the editor) and as a chat card — click whichever is more convenient.
- **Autonomous** lets SideCar work without interruption. Use for trusted tasks where you'll review changes after.
- **Manual** requires approval for every tool call, including file reads.
- **Review** is the safest mode for large multi-file changes. Writes and edits never hit disk during the agent run — they're buffered into a **Pending Agent Changes** panel where you can review each file's diff and accept or discard it before anything is persisted. See the section below.

### Diff preview in cautious mode

When the agent proposes a file write or edit in cautious mode:

1. VS Code's diff editor opens immediately, showing the original file on the left and proposed changes on the right
2. An "Accept / Reject" notification appears in the editor
3. A parallel confirmation card appears in the chat panel
4. **First click wins** — respond via whichever is more convenient
5. On Accept, the file is written; on Reject, the tool call is denied and the agent is informed

For `edit_file` operations, if inline edit (ghost text) is available, edits appear as Tab-to-accept suggestions at the edit location instead.

### Review mode — batch diff review

Review mode is designed for multi-file refactors and anything else you'd want to audit before it touches disk. When `sidecar.agentMode` is set to `review`:

1. **Nothing hits disk during the run.** Every `write_file` and `edit_file` call is captured into an in-memory `PendingEditStore` with the file's pre-edit content as a revert baseline.
2. **Reads stay consistent with the agent's view.** If the agent later calls `read_file` on a path it has already edited this session, the executor returns the pending content instead of the disk content. The agent sees a coherent picture of its own in-progress work without the user having to approve each individual step.
3. **The Pending Agent Changes panel** (in the SideCar activity bar, below the chat) refreshes live as the store changes. Each entry shows the basename, its workspace-relative directory, an icon indicating "new file" (diff-added) or "modified file" (diff-modified), and a tooltip with the last tool that touched it.
4. **Clicking any file opens VS Code's native diff editor** via `vscode.diff`. The left (baseline) side shows the content captured at the first write, not whatever's currently on disk — the diff stays stable even if you edit the file outside SideCar while a review is pending.
5. **Resolve pending changes** via:
   - **Inline icons** on each row: ✓ to accept (writes the pending content to disk, creating parent directories for new files), ✕ to discard.
   - **Panel title bar** commands: Accept All / Discard All. Discard All asks for modal confirmation since it can't be undone.
   - **Command palette**: `SideCar: Accept Pending Change`, `SideCar: Discard Pending Change`, `SideCar: Accept All Pending Changes`, `SideCar: Discard All Pending Changes`, `SideCar: Show Pending Diff`.

**Session semantics:** multiple edits to the same file collapse into a single pending entry with one consolidated before → after diff. The revert baseline is locked on the first capture, so successive edits in the same turn don't lose the original state. If you run the agent again without resolving previous pending edits, the new edits add to the same store — carry-forward is intentional so you can chain multiple agent turns before reviewing.

**v1 limitations** (deferred to follow-up work):

- No hunk-level accept/reject — it's all-or-nothing per file.
- No persistence across VS Code window reloads. If VS Code restarts mid-review, the pending edits are lost.
- No conflict detection. If you modify a file on disk while a review is pending, Accept will overwrite your edits silently.
- No in-chat affordance to toggle into review mode for a single turn — change `sidecar.agentMode` or use a custom mode.

## Stub validator

After the agent writes or edits files, SideCar automatically scans the output for placeholder patterns:

- TODO/FIXME/HACK comments
- "implement this" / "placeholder" / "stub" comments
- "real implementation" / "actual implementation" deferrals
- `throw new Error('Not implemented')` / `raise NotImplementedError`
- "for now" hedging, "would need" future deferral
- Python `pass`-only function bodies, ellipsis-only bodies (`...`)

If placeholders are detected, SideCar reprompts the model to replace them with complete implementations. This happens automatically (1 retry) and the user sees a message in chat when it fires. Issue tracker references like `TODO(#123)` are excluded to avoid false positives.

## Safety guardrails

| Setting | Default | Description |
|---------|---------|-------------|
| `sidecar.agentMaxIterations` | `25` | Max loop iterations before auto-stop |
| `sidecar.agentMaxTokens` | `100000` | Max total tokens before auto-stop |
| `sidecar.agentTemperature` | `0.2` | Temperature for tool-calling requests (lower = more deterministic) |
| `sidecar.requestTimeout` | `120` | Timeout per LLM request in seconds (0 to disable) |

Additional safety mechanisms:

- **Cycle detection** — detects repeating tool-call patterns and halts to prevent infinite loops. Length-1 patterns (the same call repeated) require 4 consecutive identical calls to trip, so agents can legitimately re-run a tool to verify after edits or retry tests after fixes without getting cut off. Length 2..4 patterns (A,B,A,B or A,B,C,A,B,C) still trip after two full cycles, since they're a much clearer signal of a stuck loop.
- **Completion gate** — forces the agent to verify its work before declaring a task done. On every agent turn, SideCar tracks which files were edited (`write_file` / `edit_file`) and which verification commands ran (`run_tests`, `eslint`, `tsc`, `vitest`, `jest`, `pytest`, `npm test`). If the agent tries to terminate a turn without having run lint or the colocated tests for a file it edited, a synthetic user message is injected into the loop demanding the checks before the turn can end. Capped at 2 injections per turn — after exhaustion the loop terminates with a warning rather than hanging. Catches the failure mode where the model reports a change as "ready for use" without ever running the checks it claims pass. Toggle with `sidecar.completionGate.enabled` (default on).
- **Tool support auto-detection** — if a model fails to use tools after 3 attempts, SideCar stops sending tool definitions to avoid wasting context
- **Request timeout** — if no tokens arrive within `requestTimeout` seconds, the request is aborted with a user-friendly message

### Conversation steering

The chat input **stays enabled** while SideCar is processing. You can:

- **Type and send a new message** at any time — this aborts the current agent run and starts a new one with your message
- **Press Escape** to abort the current run (equivalent to clicking Stop)
- **Click the Send/Stop button** — shows "Stop" when the input is empty (aborts), switches to "Send" when you start typing

This lets you steer the agent mid-run without waiting for it to finish. The backend cleanly aborts the previous loop before processing your new message.

## Built-in tools

SideCar has 22 built-in tools the agent can use:

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents |
| `write_file` | Create or overwrite files |
| `edit_file` | Search/replace edits in existing files |
| `search_files` | Glob pattern file search |
| `grep` | Content search with regex |
| `run_command` | Execute shell commands in a persistent session (env/cwd persist, background support) |
| `list_directory` | List directory contents |
| `get_diagnostics` | Read compiler errors, warnings, and security findings |
| `run_tests` | Run test suites with auto-detection |
| `spawn_agent` | Spawn parallel sub-agents for complex tasks (max depth: 3, max 15 iterations each) |
| `git_status` | Show working tree status |
| `git_stage` | Stage files for commit |
| `git_commit` | Create a commit |
| `git_log` | View commit history |
| `git_push` | Push to remote |
| `git_pull` | Pull from remote |
| `git_branch` | Create/switch/list branches |
| `git_stash` | Stash/pop changes |
| `git_diff` | Show file diffs |
| `find_references` | Find symbol references across the workspace |
| `web_search` | Search the web via DuckDuckGo |
| `display_diagram` | Extract and render diagrams from markdown files |
| `ask_user` | Ask the user a clarifying question with selectable options |

Additional tools can be added via [MCP servers](mcp-servers) and [custom tools](hooks-and-tasks#custom-tools).

## Clarifying questions

When SideCar encounters an ambiguous request or multiple valid approaches, it can use the `ask_user` tool to ask for clarification before proceeding. This presents a card in chat with:

- **Selectable option buttons** — suggested approaches the user can click to choose
- **Custom text input** — a free-text field if none of the options fit

The agent loop pauses until the user responds, then continues with the selected approach. This prevents SideCar from guessing wrong on ambiguous tasks.

SideCar also tracks when the assistant asks a question in regular prose (ending with `?`). If the user's next reply is short (under 20 words), SideCar automatically adds context so the LLM understands it's a response to the question, not a new task.

## Tool permissions

Override the approval behavior for specific tools:

```json
"sidecar.toolPermissions": {
  "run_command": "ask",
  "read_file": "allow",
  "write_file": "deny"
}
```

Values: `"allow"` (always run), `"deny"` (always block), `"ask"` (always confirm). Per-tool permissions override the agent mode.

## Diff preview

In cautious mode, `write_file` and `edit_file` open VS Code's built-in diff editor showing the proposed changes side-by-side with the original. You accept or reject via an inline confirmation card.

## Undo / rollback

SideCar snapshots every file before modifying it. To revert all changes:

- Press `Cmd+Shift+U` / `Ctrl+Shift+U`
- Or type `/undo` in the chat

After an agent run, a **change summary panel** shows all modified files with inline diffs. You can revert individual files or accept all changes.

## Custom modes

Define your own agent modes with dedicated system prompts and approval behavior via `sidecar.customModes`:

```json
"sidecar.customModes": [
  {
    "name": "architect",
    "description": "Design only, no file writes",
    "systemPrompt": "Focus on architecture decisions and API design. Propose changes but do not write files — describe what should change and why.",
    "approvalBehavior": "manual",
    "toolPermissions": { "write_file": "deny", "edit_file": "deny" }
  },
  {
    "name": "debugger",
    "description": "Diagnostic mode",
    "systemPrompt": "Focus on diagnosing the problem. Read files, check logs, run tests, and explain what's wrong before making changes.",
    "approvalBehavior": "cautious"
  }
]
```

Each custom mode has:
- **name** — identifier shown in the mode dropdown
- **description** — tooltip text in the dropdown
- **systemPrompt** — additional instructions injected into the system prompt when active
- **approvalBehavior** — `"autonomous"`, `"cautious"`, or `"manual"` (determines tool approval)
- **toolPermissions** — optional per-tool overrides (`"allow"`, `"deny"`, `"ask"`) that take priority over global `sidecar.toolPermissions`

Select custom modes from the dropdown alongside built-in modes (cautious, autonomous, manual, plan). Custom modes appear with an orange badge.

## Background agents

Run tasks in parallel without blocking your main conversation using `/bg <task>`:

```
/bg Write unit tests for src/utils/parser.ts
/bg Refactor the authentication middleware to use async/await
```

Each background agent:
- Gets its own independent client instance (no shared state with the main chat)
- Runs in **autonomous mode** with a 15-iteration cap
- Streams output in real-time to a collapsible dashboard panel below the header
- Can be stopped individually via a stop button

The dashboard shows running, queued, completed, and failed agents with elapsed time and tool call counts. Click the expand button on any agent to see its full output.

**Concurrency**: Up to 3 background agents run simultaneously (configurable via `sidecar.bgMaxConcurrent`). Additional tasks are queued and start automatically when a slot opens.

When a background agent completes, a summary is posted to the main chat so you see the result without checking the dashboard.

## Plan mode

Enable `sidecar.planMode` to have SideCar generate a plan before executing any tools. You review and approve the plan, then SideCar executes it. Useful for complex tasks where you want to validate the approach first.

## Thinking / reasoning

Models that support reasoning output show their thinking in collapsible "Reasoning" blocks:

- **Anthropic API**: Extended thinking blocks stream automatically
- **Ollama models**: `<think>...</think>` tags (used by qwen3, deepseek-r1) are parsed and displayed as reasoning blocks

Set `sidecar.expandThinking` to `true` to show reasoning blocks expanded by default.

### Reasoning timeline

Since v0.45.0, reasoning is rendered as a **numbered step timeline** rather than one growing pre-formatted block. Each thinking block closes out when a tool call starts, so a typical agent turn renders as a sequence of discrete segments:

```
[1. 🧠 Reasoning — 2.3s]
[2. 🔧 read_file — 180ms]
[3. 🧠 Reasoning — 1.1s]
[4. 🔧 edit_file — 410ms]
[5. 🧠 Reasoning — 0.9s]
```

Each segment gets a numbered pill in the summary row (purple for reasoning, blue for tools) via a CSS counter on the messages container. Duration badges show elapsed wall-clock time — steps under 500ms hide the badge to reduce visual noise. The segmentation makes it easier to see *where* the agent spent its time and *which* reasoning led to *which* tool call.

The `sidecar.expandThinking` setting still controls whether reasoning segments are open or collapsed by default; it applies to every segment in the timeline.

## Verbose mode

Enable `sidecar.verboseMode` or type `/verbose` to see detailed agent internals:

- **System prompt** — the full assembled prompt shown at the start of each run
- **Iteration summaries** — elapsed time and token counts per iteration
- **Tool selection** — which tool was chosen and why

Verbose output appears in yellow-bordered collapsible blocks. Use `/prompt` to inspect the system prompt at any time.

## Progress indicators

During agent runs, the UI shows:
- **Step count** and **max iterations**
- **Elapsed time**
- **Token usage**
- **Animated progress bar** and **tool execution pulses**
