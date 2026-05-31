---
title: Privacy and Security
layout: docs
nav_order: 25
---

# Privacy and Security

This guide answers the practical question: **is it safe to use SideCar on my codebase?**

The honest answer is: it depends on your threat model and which features you turn on. SideCar has meaningful defenses, meaningful gaps, and a few controls that let you tighten the perimeter significantly. This page explains all three.

---

## What leaves your machine

### Local backends: nothing

When you use **Ollama** (`http://localhost:11434`) or **Kickstand** (`http://localhost:11435`), every LLM request stays on your machine. No prompt text, no file contents, no tool results ever travel over the network. SideCar has no built-in telemetry of its own — the only network egress is to the backend URL you configure and any web-search or MCP endpoints you add.

If you're in a sensitive environment and want to verify this, set `sidecar.outboundAllowlist` to a single entry:

```json
"sidecar.outboundAllowlist": ["localhost"]
```

Any outbound URL that doesn't match `localhost` will be blocked.

### Cloud backends: prompts go to their API

When you use **Anthropic**, **OpenAI**, **OpenRouter**, **Groq**, or **Fireworks**, SideCar sends your conversation to that provider's API over HTTPS. This includes everything in the context at send time:

- **File contents** included in the context window (the files indexed by `sidecar.filePatterns`, up to `sidecar.maxFiles`)
- **Shell output** from `run_command` and `run_tests` tool results
- **Compiler diagnostics** from `get_diagnostics`
- **Git history** from `git_log` and `git_diff` tool calls
- **Clipboard or pasted content** you include in chat

SideCar does not send your entire filesystem, only what the agent actually needs for the task at hand. The relevance scorer and `sidecar.maxFiles` cap how many files go into context; `sidecar.maxFileSizeBytes` (default 100 KB) prevents large binary or generated files from landing in prompts.

### What SideCar never sends

- **API keys** — stored in VS Code SecretStorage, never serialized into prompts or settings files
- **Full filesystem scans** — the indexer respects `sidecar.maxFiles`, `sidecar.maxIndexedFiles`, and `.sidecarignore`
- **Your own telemetry** — SideCar has no analytics endpoint

---

## API key protection

### Keys live in the OS keychain

API keys are stored in **VS Code SecretStorage**, which maps to the macOS Keychain, Windows Credential Manager, or libsecret on Linux. They are never written to `settings.json` or any file on disk in plaintext.

To set or rotate a key, run `SideCar: Set / Refresh API Key` from the Command Palette, or click the key icon in the chat header. An empty input is rejected; values are whitespace-trimmed before storage.

### Migration from plaintext

If you previously set `sidecar.apiKey` in `settings.json` (before SecretStorage was introduced), SideCar migrates it automatically on the next activation:

1. Reads the plaintext value from `settings.json`
2. Stores it in SecretStorage
3. Clears the value from `settings.json`

After migration, `settings.json` shows the default `"ollama"` placeholder. The actual key is in the keychain and never leaves it.

### Per-profile isolation

Each backend profile stores its key in its own SecretStorage slot (`sidecar.profileKey.<id>`). Switching between Anthropic and OpenAI does not clobber either key, and settings sync does not push keys to other devices — per-machine isolation is a design property of SecretStorage.

The **Kickstand** profile has no key at all. SideCar reads the bearer token directly from `~/.config/kickstand/token` on demand, so it never prompts you and never stores anything.

---

## Controlling what the agent can read and write

### Exclude sensitive paths with .sidecarignore

Create a `.sidecarignore` file in your workspace root using the same syntax as `.gitignore`:

```
# Never include these in agent context
secrets/
.env
.env.*
infra/terraform/
*.pem
*.key
config/production/
```

Patterns merge with the default excludes (`.git`, `.sidecar`, `node_modules`). Files matching `.sidecarignore` are excluded from workspace indexing, context auto-selection, and the agent's `search_files` glob results.

### Lock URL fetching with the outbound allowlist

By default, `web_search` and `fetch_url` can reach any public internet host (with built-in SSRF and private-IP blocking). If you want to restrict what the agent can fetch, set `sidecar.outboundAllowlist`:

```json
"sidecar.outboundAllowlist": [
  "docs.anthropic.com",
  "*.github.com",
  "crates.io"
]
```

Requests to hosts that don't match any entry are blocked before they leave the extension. Leading `*.` matches all subdomains. An empty array (the default) allows all public URLs.

### Per-tool allow/deny overrides

`sidecar.toolPermissions` overrides the approval behavior for any individual tool, regardless of the current agent mode:

```json
"sidecar.toolPermissions": {
  "run_command": "ask",
  "git_push": "deny",
  "write_file": "ask",
  "delete_file": "deny"
}
```

`"allow"` runs the tool without prompting. `"deny"` blocks it entirely — the agent is told the tool is unavailable. `"ask"` always shows an approval dialog, even in autonomous mode.

To lock down a shared or CI codebase so the agent can read but never write, combine `write_file`, `edit_file`, `delete_file`, `git_push`, `git_commit` with `"deny"`.

### Repo-level policy file

For shared repos or CI environments where you want restrictions checked into source control, create `.vscode/settings.json` in the repo with `sidecar.toolPermissions` set:

```json
{
  "sidecar.agentMode": "review",
  "sidecar.toolPermissions": {
    "git_push": "deny",
    "run_command": "ask"
  }
}
```

SideCar routes workspace settings through a per-session trust prompt (`checkWorkspaceConfigTrust`) before applying them — a cloned repo's settings don't take effect until you acknowledge the trust prompt. This prevents a malicious repo from pre-configuring a permissive mode without your awareness.

---

## Audit Mode: reviewing writes before they hit disk

Audit Mode (`sidecar.agentMode: "review"`) is the safest mode for multi-file changes you want to inspect before committing to disk. It differs from cautious mode in a key way: in cautious mode you approve each write as it happens; in review mode the agent runs to completion first and you review everything at the end.

### Enabling it

```json
"sidecar.agentMode": "review"
```

Or select **Review** from the mode dropdown in the chat header.

### What happens during the run

Every `write_file`, `edit_file`, and `delete_file` call is diverted into an in-memory buffer. Nothing touches disk. The agent reads its own buffered content for subsequent reads — so if it writes `foo.ts` and later reads it back, it sees the buffered version, not the old file. Multi-step edits stack correctly and the agent has no awareness of the buffer.

The **Pending Agent Changes** panel (in the SideCar activity bar) refreshes live as entries accumulate. Each entry shows the file name, directory, operation type (new / modified / deleted), and the last tool that touched it.

### Reviewing and accepting

Click any entry to open VS Code's native diff editor. The left side shows the content captured at the agent's first write — not the current on-disk state. The diff stays stable even if you manually edit the file while a review is pending.

Accept or discard via:

- **Inline icons** on each row: ✓ accept, ✕ discard
- **Panel title bar**: Accept All / Discard All
- **Command Palette**: `SideCar: Accept All Pending Changes`, `SideCar: Discard All Pending Changes`

### Atomic flush behavior

When you Accept All, SideCar flushes entries in a single pass. If any individual write fails mid-flush, every already-applied write is rolled back to its original content and an `AuditFlushError` is thrown. Either all writes land, or none do — you never end up with a partial set of files on disk from a failed flush.

Commit failures are handled separately: if the file writes succeed but a queued `git_commit` fails, the writes stay on disk (rolling them back would lose the agent's work) and the commit remains queued for you to retry manually. The error message identifies this half-state explicitly.

### Buffering git commits

By default, `sidecar.audit.bufferGitCommits` is `true`. When enabled, `git_commit` calls are queued alongside file writes and executed as part of the same flush. This keeps `HEAD` clean until you explicitly accept — so rejecting all changes also discards any commits the agent tried to make.

Set it to `false` if you want commits to land immediately even in review mode:

```json
"sidecar.audit.bufferGitCommits": false
```

---

## Shadow Workspaces: full git isolation

Shadow Workspaces go further than Audit Mode. Instead of buffering writes in memory, the agent runs inside an **ephemeral git worktree** at `.sidecar/shadows/<task-id>/` branched off the current `HEAD`. Your main working tree is completely untouched during the run.

### Enabling it

```json
"sidecar.shadowWorkspace.mode": "always"
```

Or use `"opt-in"` to shadow only tasks that explicitly request it via the `/sandbox` slash command.

### What it protects against

Because the agent runs in a separate worktree, a runaway task — one that deletes files, makes bad edits, or corrupts a build — cannot damage your main tree. Every file system write goes to the shadow path. `read_file` reads from the shadow. Shell commands run with `cwd` set to the shadow directory.

At task completion, SideCar shows a diff summary (file count, line count, key paths) and prompts Accept or Reject:

- **Accept** applies the diff to main as staged changes, visible in `git status`. You still review before committing.
- **Reject** deletes the shadow worktree and leaves your main tree untouched.

### When to use it

Use shadow mode for any agent task where you aren't fully confident in the outcome: large refactors, deletions, unfamiliar codebases, or tasks the agent will run autonomously while you're away. The cost is a second worktree on disk; the benefit is an unconditional rollback path.

Fork mode (`/fork`) forces shadow mode unconditionally — every parallel branch runs in its own shadow, and you pick the winner from a diff-by-diff comparison.

---

## macOS Seatbelt sandbox

On macOS, SideCar wraps every `run_command` and `run_tests` call with `/usr/bin/sandbox-exec` and a deny-default SBPL profile. The profile allows:

- **Reads** from anywhere (agents need to read source files during builds)
- **Writes** to the workspace root, `/tmp`, and common build caches (`~/.npm`, `~/.cargo`, `~/.gradle`, `~/.m2`)
- **Outbound network** connections
- **Everything else denied** — writes outside the workspace, sensitive system paths, process spawning outside the restricted set

This means a misbehaving agent command like `rm -rf ~` or `cp ~/.ssh/id_rsa /tmp/exfil` will fail with a permission denied at the OS level, not just a SideCar approval dialog.

`sidecar.sandbox.enabled` defaults to `true` on macOS and is automatically disabled on Linux and Windows where `sandbox-exec` is unavailable. Disable it only if a specific tool you rely on writes legitimately outside the allowed paths and you have verified it is safe:

```json
"sidecar.sandbox.enabled": false
```

Note: the Seatbelt sandbox covers shell execution only. File writes through SideCar's own `write_file` tool are not separately sandboxed at the OS level — that's what Audit Mode and Shadow Workspaces are for.

---

## Secret scanning

### Staged file scanning

Before any `git_commit`, SideCar scans staged file content against `SECRET_PATTERNS` — a catalog of regexes covering AWS access keys and secret keys, GitHub tokens (`ghp/gho/ghu/ghs/ghr`), Anthropic keys (`sk-ant-...`), OpenAI keys (`sk-...`), HuggingFace tokens, Cohere, Replicate, Stripe live secrets, Twilio Account SIDs, SendGrid, Mailgun, Google API keys (`AIza...`), Azure storage connection strings, npm tokens, PyPI tokens, Slack tokens (`xox[bprs]-...`), PEM private keys, JWTs, database connection strings with inline credentials, and generic `api_key=`/`secret=`/`password=`/`token=` heuristics.

Matches surface as diagnostics in the VS Code **Problems** panel. The scan is advisory — it surfaces findings without blocking the commit. Treat a match as a signal to rotate the exposed credential immediately, even if it appeared in a test file.

Pattern gaps exist. A key format we haven't catalogued yet will slip through. If you find one, report it at `sidecarai.vscode@gmail.com` with subject `[security]`.

### Redaction before external calls

`redactSecrets(text)` replaces every pattern match with `[REDACTED:<name>]` before:

- Forwarding tool inputs to **custom tool** child process environments (`SIDECAR_INPUT`)
- Forwarding `tool_result` bodies to **external MCP servers**
- Writing to **verbose logs** (`.sidecar/logs/api.jsonl` when `sidecar.verboseLogs` is on)

This means a secret that ends up in a shell command's output will be redacted before it leaves the extension's process boundary.

### Prompt injection defense on MCP output

Every MCP tool response is wrapped in XML-style boundary markers:

```
<mcp_tool_output server="my-server" tool="run_task" trust="untrusted">
  ...content...
</mcp_tool_output>
```

A heuristic detector (`detectInjectionSignals`) scans the content for common injection patterns: `ignore previous instructions`, fake `SYSTEM:` roles, ChatML injection sequences. Detection is advisory — findings log a warning but never block the turn. The boundary markers themselves reinforce the base system prompt's standing rule that tool output is data, not instructions, by attributing each chunk to a specific server and tool.

### Credential-shaped tokens in web search

The `web_search` tool blocks queries containing credential-shaped tokens (AWS access keys, GitHub tokens, JWTs) before they reach any search provider. This prevents the agent from accidentally leaking a key it found in a source file into a search query that gets logged by the provider.

---

## Air-gapped and corporate environments

### Zero outbound traffic

Point SideCar at a local Ollama or Kickstand instance and nothing leaves your network:

```json
"sidecar.baseUrl": "http://localhost:11434",
"sidecar.provider": "ollama"
```

Or for Kickstand:

```json
"sidecar.baseUrl": "http://localhost:11435",
"sidecar.provider": "kickstand"
```

Kickstand reads its bearer token from `~/.config/kickstand/token` with no additional configuration.

### Disable skill registry sync

The skills registry fetches skill definitions from git URLs on activation. In an air-gapped environment, disable sync entirely:

```json
"sidecar.skills.offline": true
```

When `offline` is `true`, the loader reads only from what is already cached locally and makes no network calls.

### Lock URL fetching to approved domains

```json
"sidecar.outboundAllowlist": [
  "internal-docs.corp.example.com",
  "*.internal.example.com"
]
```

Every `web_search` and URL fetch that doesn't match the allowlist is blocked. The dependency drift scanner (OSV API calls) can be turned off separately:

```json
"sidecar.deps.checkVulnerabilities": false
```

### MCP stdio transport

If you use MCP servers, prefer **stdio** transport — it spawns a local process and communicates over stdin/stdout with no network involvement. HTTP and SSE transports connect outbound. stdio MCP servers are hard-blocked in untrusted workspaces; they only activate after you explicitly trust the workspace via VS Code's workspace-trust mechanism.

---

## Responsible use of the agent

### Never let the agent push directly to main

Set a `"deny"` override for `git_push` in your workspace settings:

```json
"sidecar.toolPermissions": {
  "git_push": "deny"
}
```

With this in place, the agent can stage, commit, and prepare a branch, but the push requires you to run it manually. Combined with branch protection rules on the remote, this means no agent-authored commit can reach main without going through your standard review process.

### Always run agent tasks on a feature branch

Before starting a long agent task:

```
/branch feature/agent-refactor
```

Or manually: `git checkout -b feature/agent-task`. Agent writes land on the branch. If the result is unsatisfactory, `git checkout main && git branch -D feature/agent-task` discards everything without touching main.

### Review agent PRs before merging

The agent's `create_pr_review` and related tools produce pull requests you should treat the same way you'd treat a junior contributor's PR — review the diff, run CI, check for unintended side effects. `sidecar.pr.create.draftByDefault` is `true`, which opens new PRs as drafts so CI runs without notifying reviewers prematurely.

Enable branch protection on `main` / `master` requiring at least one human approval before merge. This is a repository-level setting on GitHub/GitLab, not a SideCar setting — it's the last line of defense against any agent-authored code landing in production without review.

### Limit autonomous mode to trusted tasks

`sidecar.agentMode: "autonomous"` gives the agent write and execution rights without per-action approval. Reserve it for well-defined, bounded tasks (running tests, updating dependencies, reformatting code) on a branch where recovery is straightforward. For exploratory or large-scope tasks, start in `"cautious"` or `"review"` mode and switch only if you're confident in the direction.

---

## Vulnerability reporting

If you find a security issue in SideCar, do not open a public GitHub issue. Report it privately:

- **Email**: `sidecarai.vscode@gmail.com` with subject prefix `[security]`
- **GitHub**: use the "Report a vulnerability" button on the repo's Security tab

Include the SideCar version, a description of the impact, and reproduction steps. Response targets: acknowledgement within 72 hours, triage within one week, fix within one week for critical issues. See [SECURITY.md](https://github.com/nedonatelli/sidecar/blob/main/SECURITY.md) for the full policy.
