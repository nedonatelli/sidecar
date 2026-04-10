---
title: Observability
layout: docs
nav_order: 11
---

# Observability

SideCar provides three observability features to help you understand, audit, and optimize how the agent works: an **audit log** for every tool execution, **decision explanations** for individual tool calls, and **conversation analytics** for usage patterns and trends.

## Agent action audit log

Every tool execution is recorded as a structured entry in `.sidecar/logs/audit.jsonl`. This append-only log captures:

| Field | Description |
|-------|-------------|
| `timestamp` | ISO 8601 timestamp |
| `sessionId` | Agent session identifier |
| `tool` | Tool name |
| `toolCallId` | Unique call ID from the model |
| `input` | Tool input parameters |
| `result` | Truncated result (first 500 chars) |
| `isError` | Whether the call errored |
| `durationMs` | Execution time in milliseconds |
| `iteration` | Agent loop iteration number |
| `approvalMode` | Active approval mode |
| `model` | Model that made the decision |

### Browsing the audit log

Use the `/audit` command to browse entries:

```
/audit                    Show last 50 entries
/audit errors             Show only failed tool calls
/audit tool:grep          Filter by tool name
/audit last:20            Show last 20 entries
/audit since:2026-04-01   Show entries after a date
/audit clear              Clear the entire log
```

Filters can be combined: `/audit errors tool:write_file last:10`

The audit log opens as a markdown table in a new editor tab with columns for time, tool, duration, status, input preview, and result preview.

### Storage

The audit log is stored in `.sidecar/logs/audit.jsonl` (gitignored). Each line is a self-contained JSON object, making it easy to parse with external tools:

```bash
# Count tool calls by name
cat .sidecar/logs/audit.jsonl | jq -r .tool | sort | uniq -c | sort -rn

# Find slowest tool calls
cat .sidecar/logs/audit.jsonl | jq -r '[.tool, .durationMs] | @tsv' | sort -t$'\t' -k2 -rn | head

# Export errors
cat .sidecar/logs/audit.jsonl | jq 'select(.isError)' > errors.json
```

## Model decision explanations

After a tool call completes, a **"Why?"** button appears on the tool card in chat. Clicking it sends a focused prompt to the model asking it to explain:

1. What information or goal motivated the tool call
2. Why this tool was chosen over alternatives
3. Whether the result was as expected

The explanation appears inline in the chat as a short (2-3 sentence) response. The button is visible on hover to keep the UI clean.

### How it works

The "Why?" feature uses the audit log to retrieve the full context of the tool call (input parameters, result, duration, error status), then sends a single-shot prompt to the current model. This costs a small number of tokens per explanation but requires no pre-computation or storage.

## Conversation pattern analysis

The `/insights` command generates a comprehensive analytics report from your audit log, metrics history, and agent memory. The report opens as a markdown document with the following sections:

### Overview

Summary statistics: total tool executions, sessions analyzed, average tools per session, average session duration, and date range.

### Tool performance

Table showing each tool's call count, error count, error rate, and average duration. Sorted by frequency.

### Usage distribution

ASCII bar chart showing relative tool usage across all sessions.

### Common tool sequences

The most frequent 2-tool sequences (e.g., `read_file -> edit_file`). Helps identify common workflows.

### Tool co-occurrence

Tools that frequently appear in the same session. Reveals which tools are naturally used together.

### Activity by hour

Hourly activity heatmap showing when you're most active. Identifies peak usage hours.

### Error clusters

Sessions where multiple tools failed together. Helps identify systemic issues vs. isolated failures.

### Suggestions

Actionable recommendations based on the data:

- **High error rate tools** — tools failing more than 30% of the time
- **Slow tools** — tools averaging over 5 seconds, with suggestions to narrow inputs
- **Repetitive sequences** — tools called back-to-back repeatedly (may indicate retry loops)
- **High iteration counts** — suggestions to break complex tasks into smaller prompts

### Learned patterns

Top patterns from agent memory, ranked by use count. Shows conventions and decisions the agent has internalized.

## Slash command reference

| Command | Description |
|---------|-------------|
| `/audit` | Browse the agent action audit log |
| `/insights` | Generate conversation pattern analysis |
| `/mcp` | Show MCP server connection status |
| `/usage` | Token usage and cost dashboard |
| `/context` | Visualize context window breakdown |
| `/insight` | Activity analytics (tool call frequency, error rates) |

## Data sources

The observability features draw from three data stores:

| Store | Location | Persistence | What it tracks |
|-------|----------|-------------|----------------|
| Audit log | `.sidecar/logs/audit.jsonl` | File (gitignored) | Every tool call with full context |
| Metrics | VS Code workspace state | Per-workspace | Per-run aggregates (iterations, tokens, cost, tool counts) |
| Agent memory | `.sidecar/memory/agent-memories.json` | File (committed) | Learned patterns, conventions, decisions |
