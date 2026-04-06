---
title: Slash Commands
layout: default
nav_order: 6
---

# Slash Commands

Type `/` in the chat input to see all available commands. An autocomplete dropdown appears as you type, with descriptions and keyboard navigation (arrow keys, Tab/Enter to select, Escape to dismiss).

## Command reference

| Command | Description |
|---------|-------------|
| `/reset` | Clear conversation history |
| `/undo` | Revert all AI file changes |
| `/export` | Export chat as Markdown file |
| `/model <name>` | Switch model mid-conversation |
| `/help` | Show available commands |
| `/batch` | Run multiple tasks |
| `/doc` | Generate documentation |
| `/spec` | Generate structured requirements |
| `/insight` | Activity analytics |
| `/save <name>` | Save current session |
| `/sessions` | Browse saved conversations |
| `/scan` | Scan staged files for secrets |
| `/usage` | Token usage dashboard |
| `/context` | Visualize context window |
| `/test` | Generate tests |
| `/lint` | Run linter |
| `/deps` | Analyze dependencies |
| `/scaffold <type>` | Generate boilerplate |
| `/commit` | Generate commit and push |

---

## Conversation

### `/reset`

Clears the conversation history and starts a new chat. Equivalent to clicking the "New Chat" button.

### `/export`

Exports the full conversation as a Markdown file. A save dialog lets you choose the location.

### `/save <name>`

Saves the current conversation with a name. Named sessions persist across VS Code restarts.

### `/sessions`

Opens the session browser panel. Browse, load, or delete saved conversations. Sessions auto-save after each assistant response.

---

## Code generation

### `/doc`

Generates JSDoc or docstring documentation for the active file or selected code. Detects the language and uses the appropriate documentation format.

### `/test`

Generates tests for the active file or selection. Auto-detects your test framework:
- **JavaScript/TypeScript**: Vitest, Jest
- **Python**: pytest
- **Go**: Go test
- **Rust**: Cargo test
- **Java**: JUnit

Creates a properly named test file (e.g., `foo.test.ts` for `foo.ts`).

### `/scaffold <type>`

Generates boilerplate code from built-in templates. Available types:

| Type | What it generates |
|------|-------------------|
| `component` | React/Vue/Svelte component |
| `api` | REST API endpoint |
| `test` | Test file with framework setup |
| `model` | Data model / schema |
| `cli` | CLI tool scaffold |
| `hook` | React hook |
| `middleware` | Express/Koa middleware |
| `service` | Service class with dependency injection |

Run `/scaffold` with no arguments to see all available templates.

### `/spec`

Generates structured requirements using EARS notation (Easy Approach to Requirements Syntax). Includes design decisions and dependency-sequenced implementation tasks. Specs are saved to `.sidecar/specs/`.

---

## Code quality

### `/lint`

Runs your project's linter with auto-detection:
- **ESLint** (JavaScript/TypeScript)
- **Ruff** (Python)
- **golangci-lint** (Go)

Pass a custom command: `/lint npx eslint --fix .`

### `/scan`

Scans staged git files for secrets and vulnerabilities before committing. See [Security Scanning](security-scanning) for details.

### `/deps`

Analyzes project dependencies:
- Package counts and lists
- Unused package detection (Node.js)
- Outdated version checks
- Supports Node.js, Python, and Go

---

## Observability

### `/usage`

Shows a token usage dashboard:
- Cumulative token consumption
- Estimated Anthropic API cost
- Per-run history
- Tool usage breakdown

### `/context`

Visualizes what's in the current context window:
- System prompt
- SIDECAR.md content
- Workspace files with token counts
- Conversation history
- Visual usage bar showing total utilization

### `/insight`

Generates an activity analytics report:
- Tool call frequency and duration
- Error rates
- Token statistics per run

---

## Task management

### `/batch`

Run multiple tasks sequentially or in parallel:

```
/batch Fix all TypeScript errors; Add missing tests; Run the linter
```

Use `--parallel` to run tasks concurrently:

```
/batch --parallel Generate docs for auth.ts; Generate docs for api.ts
```

---

## Git

### `/commit`

Generates a commit message from the current diff, stages all changes, and commits. The commit includes a `Co-Authored-By: SideCar` trailer.

### `/undo`

Reverts all file changes made by SideCar in the current session. SideCar snapshots every file before modifying it, so undo restores the exact original content.

---

## Model

### `/model <name>`

Switches to a different model mid-conversation. The conversation history is preserved. Updates the status bar and saves the preference.

```
/model claude-sonnet-4-6
/model qwen3-coder:8b
```
