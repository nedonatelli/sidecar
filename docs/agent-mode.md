---
title: Agent Mode
layout: default
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

- **Cautious** is recommended for most use. File reads happen automatically; writes and edits show a diff preview for your approval.
- **Autonomous** lets SideCar work without interruption. Use for trusted tasks where you'll review changes after.
- **Manual** requires approval for every tool call, including file reads.

## Safety guardrails

| Setting | Default | Description |
|---------|---------|-------------|
| `sidecar.agentMaxIterations` | `25` | Max loop iterations before auto-stop |
| `sidecar.agentMaxTokens` | `100000` | Max total tokens before auto-stop |

The **Stop button** (the Send button toggles to a red Stop during processing) lets you abort at any time. Partial changes can be reverted with Undo.

## Built-in tools

SideCar has 19 built-in tools the agent can use:

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
| `spawn_agent` | Spawn parallel sub-agents for complex tasks |
| `git_status` | Show working tree status |
| `git_stage` | Stage files for commit |
| `git_commit` | Create a commit |
| `git_log` | View commit history |
| `git_push` | Push to remote |
| `git_pull` | Pull from remote |
| `git_branch` | Create/switch/list branches |
| `git_stash` | Stash/pop changes |
| `git_diff` | Show file diffs |

Additional tools can be added via [MCP servers](mcp-servers) and [custom tools](hooks-and-tasks#custom-tools).

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

## Plan mode

Enable `sidecar.planMode` to have SideCar generate a plan before executing any tools. You review and approve the plan, then SideCar executes it. Useful for complex tasks where you want to validate the approach first.

## Thinking / reasoning

Models that support reasoning output show their thinking in collapsible "Reasoning" blocks:

- **Anthropic API**: Extended thinking blocks stream automatically
- **Ollama models**: `<think>...</think>` tags (used by qwen3, deepseek-r1) are parsed and displayed as reasoning blocks

Set `sidecar.expandThinking` to `true` to show reasoning blocks expanded by default.

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
