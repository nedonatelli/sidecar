---
title: FAQ
layout: docs
nav_order: 1
nav_section: "Help"
---

# FAQ

---

## Setup & Compatibility

### What version of VS Code does SideCar require?

VS Code 1.93 or later. Some features (terminal error interception, shell-integration routing for agent commands) require 1.93+ specifically. Older builds may work for basic chat but are not tested.

### Does SideCar work in Cursor, VSCodium, or other VS Code forks?

Cursor and VSCodium are broadly compatible — they share the VS Code extension API. Features that depend on platform-specific APIs (macOS Seatbelt sandbox, shell-integration terminal routing) may behave differently. There is no dedicated test matrix for forks; report issues on GitHub with the fork name and version.

### Can I use SideCar without installing Ollama?

Yes. Ollama is the default backend but is not required. You can connect SideCar to the Anthropic API, OpenAI, OpenRouter, Groq, Fireworks, LM Studio, or any OpenAI-compatible server instead. Switch backends via the gear in the chat header. See [getting started](getting-started) for per-backend setup.

### What is Kickstand?

Kickstand is a self-hosted local inference server that manages model loading, unloading, and GPU memory. CLI command: `kick`. It exposes an OpenAI-compatible endpoint at `localhost:11435` plus management APIs for pulling and loading models. SideCar auto-detects it by port and reads its bearer token from `~/.config/kickstand/token` — no API key prompt needed. It is a separate project from SideCar.

### Can I run SideCar in a Dev Container or over remote SSH?

Yes. Agent shell commands route through VS Code's shell-integration API, which inherits the remote shell session. That means `run_command` and `run_tests` execute inside the container or on the remote host, not on your local machine. `sidecar.terminalExecution.enabled` controls this; it falls back to a `child_process` session automatically when shell integration is unavailable.

### Does SideCar work in VS Code Web (vscode.dev / GitHub Codespaces)?

The extension targets the desktop API surface. Some capabilities (native file system access, child process execution, Seatbelt sandbox) are not available in the browser host. Basic chat works in Codespaces via the remote extension host. Full agent mode requires the desktop or a connected remote.

---

## Models & Backends

### Which model should I start with?

For Ollama: `gemma4:e4b` (the default) is a good starting point. On machines with less RAM, try `gemma4:2b` or `qwen2.5-coder:7b`. For agent tasks that require reliable tool use, `qwen3-coder` variants perform well. For the Anthropic API: `claude-sonnet-4-6` is the recommended default.

### How do I connect to OpenRouter, Groq, or Fireworks?

All three are OpenAI-compatible. Set `sidecar.baseUrl` to the provider's endpoint, paste your API key via `SideCar: Set / Refresh API Key`, and set `sidecar.model` to the model name.

| Provider | Base URL |
|----------|----------|
| OpenRouter | `https://openrouter.ai/api` |
| Groq | `https://api.groq.com/openai` |
| Fireworks | `https://api.fireworks.ai/inference` |

SideCar auto-detects these as OpenAI-compatible. If detection is wrong, set `"sidecar.provider": "openai"` explicitly. See [getting started](getting-started#using-openai-compatible-servers) for the full provider table.

### How do I connect to LM Studio?

Point `sidecar.baseUrl` at `http://localhost:1234` (LM Studio's default). SideCar auto-detects it as OpenAI-compatible. No API key is needed for local servers. Make sure LM Studio has the OpenAI-compatible server enabled in its settings.

### Some models fail to use tools. What is happening?

Not all models support function calling. SideCar detects this automatically: if a model fails to invoke tools after 3 attempts, it stops sending tool definitions and falls back to chat-only mode. For full agent capabilities, use models tagged **Full Features (Tools)** in the model dropdown. If a capable model is behaving incorrectly, try lowering `sidecar.agentTemperature` (default `0.2`) and confirming the model version supports the JSON tool-call format your server is configured for.

### How do I reduce my Anthropic API bill?

Several levers:

- **Prompt caching**: SideCar enables Anthropic prompt caching automatically, reducing input token costs by ~90% on cache hits.
- **Editor model**: set `sidecar.editorModel` to a cheaper model (e.g. `claude-haiku-4-5`) for execution turns while keeping Sonnet for planning turns.
- **Prompt pruning**: `sidecar.promptPruning.enabled` (default on) collapses whitespace and truncates oversized tool results. Tune `sidecar.promptPruning.maxToolResultTokens` down for exploration-heavy tasks.
- **Delegate task**: `sidecar.delegateTask.enabled` (default on) offloads read-only codebase research to a free local Ollama worker, saving 60–80% of input tokens on file-heavy turns.
- **Spending budgets**: set `sidecar.dailyBudget` or `sidecar.weeklyBudget` in USD. Agent runs are blocked at 100% and warned at 80%. Track current spend with `SideCar: Show Session Spend` or `/usage`.

See [configuration — cost controls](configuration#cost-controls-paid-backends) for details.

### Can I use different models for different tasks within the same session?

Yes, via model routing. Set `sidecar.modelRouting.enabled: true` and define rules in `sidecar.modelRouting.rules`. Rules can match on role (`agent-loop`, `chat`, `critic`, `planner`), file glob, prompt regex, or task complexity. A cheaper model handles chat; a frontier model handles agent planning. Per-rule budget caps auto-downgrade to a fallback model when hit. See [configuration — model routing](configuration#model-routing).

---

## Agent Behavior

### The agent is repeating the same action. How do I stop it?

SideCar has two-tier cycle detection built in. An exact-match ring buffer fires after 4 consecutive identical tool calls; a normalized-signature buffer catches "same tool, same file, different content" loops after 3 cycles. When either trips, the agent halts automatically and posts a message in chat explaining what happened.

If you are seeing a loop that was not caught: press Escape or click Stop to abort the run, then steer the agent with a follow-up message. You can also lower `sidecar.agentMaxIterations` (default 25) to set a harder cap.

### How do I prevent the agent from touching certain files?

Three approaches:

1. **.sidecarignore**: create a `.sidecarignore` file in the workspace root (same syntax as `.gitignore`). Files matching those patterns are excluded from workspace indexing. The agent won't discover those files during relevance-scored context building.
2. **Per-tool deny**: add `"write_file": "deny"` and `"edit_file": "deny"` to `sidecar.toolPermissions` to block all writes globally, or use a custom mode with those restrictions for specific sessions.
3. **Review mode**: in `review` mode all writes are buffered and nothing hits disk until you explicitly accept. You can discard individual files without accepting the full batch.

### What is the difference between cautious, autonomous, review, and manual modes?

| Mode | File reads | File writes | Destructive ops (shell, git) |
|------|------------|-------------|------------------------------|
| Cautious (default) | Auto | Diff preview — you confirm | Confirm |
| Autonomous | Auto | Auto | Confirm |
| Manual | Confirm | Confirm | Confirm |
| Review | Auto | Buffered — nothing hits disk | Confirm |

**Cautious** is the recommended default. **Autonomous** is for trusted batch tasks. **Review** is for large multi-file refactors where you want to audit everything before anything is written. **Manual** is for high-stakes work where you want visibility into every operation. See [agent mode — approval modes](agent-mode#approval-modes).

### The agent declared the task done but the task is not complete. Why?

A few possible causes:

- **Completion gate disabled or exhausted**: `sidecar.completionGate.enabled` (default on) forces the agent to run lint and colocated tests before declaring a turn finished. If it fired but the model still reported completion, enable `sidecar.autoFixOnFailure` to feed diagnostic errors back automatically.
- **Missing verification**: rephrase the task to include an explicit verification step — "Fix the bug and confirm the test suite passes."
- **Context gap**: the agent may not have seen all relevant files. Use `@pin:path` to pin specific files, or ask "What files did you check?" as a follow-up.
- **Model quality**: chat-only models and smaller models are more likely to hallucinate completion. Switch to a tool-capable model with stronger instruction following.

### Can I send the agent a new instruction while it is still running?

Yes. The chat input stays active during agent runs. Type a new message and send it — SideCar aborts the current run and starts a new one with your message. Press Escape or click Stop to abort without starting a new task. The SteerQueue lets you queue a lower-urgency follow-up that drains at the next iteration boundary without aborting the current tool call.

### How do I run multiple agent tasks in parallel?

Use `/bg <task>` to launch background agents. Up to 3 run simultaneously (configurable via `sidecar.bgMaxConcurrent`). Each background agent gets its own client instance and streams output to the dashboard panel below the chat header.

For specialist parallel work, **Facets** (`SideCar: Facets: Dispatch Specialists`) dispatches named role-based sub-agents — `test-author`, `security-reviewer`, `frontend`, etc. — each with its own tool allowlist and model, all running in isolated Shadow Workspaces with a single aggregated review at the end. See [agent mode — typed sub-agent facets](agent-mode#typed-sub-agent-facets-new-in-v066).

---

## Context & Memory

### How much of my codebase does the agent actually see?

Context is assembled from three layers:

1. **Active file**: the file open in the editor (always included by default).
2. **Workspace relevance scoring**: up to `sidecar.maxFiles` (default 10) additional files ranked by semantic and keyword relevance to your query.
3. **Pinned files**: files or folders in `sidecar.pinnedContext` or pinned inline with `@pin:path` — always included regardless of relevance score.

The total is bounded by `sidecar.contextLimit` (auto-detected per model). Large files above `sidecar.streamingReadThreshold` (50KB default) get head + tail summaries rather than full content. The agent can also call `read_file` explicitly to pull in any file during a run.

For large monorepos, set `sidecar.workspaceRoots` to focus indexing on active sub-projects, and use `.sidecarignore` to exclude irrelevant directories.

### What is SIDECAR.md?

`SIDECAR.md` (at the workspace root or under `.sidecar/`) is a project-specific instruction file the agent reads at the start of every session. Use it to document conventions, architecture decisions, preferred patterns, and anything else you would want the agent to know before touching the codebase.

Sections can be scoped to specific file globs with a `<!-- @paths: glob, glob -->` sentinel directly below the heading — those sections only inject when matching files are in context. Headings listed in `sidecar.sidecarMd.alwaysIncludeHeadings` always inject regardless of scope.

For large files with many sections, set `sidecar.sidecarMd.mode: "retrieval"` — sections are embedded and retrieved by semantic similarity at query time rather than injected wholesale. See [configuration — SIDECAR.md](configuration#sidecarmd-path-scoped-section-injection-v067--retrieval-mode-v092).

### The agent forgot something I told it earlier. How do I fix that?

Long sessions trigger context compression — older turns are summarized and compacted to stay within the model's context window. The episodic memory layer embeds those summaries and retrieves relevant ones before each turn, but retrieval is not perfect.

To make context persistent across compression:

- **Pin a note**: type `/memories` to open the pinned memory panel. Pin a text note or file snippet. Pinned entries inject into every turn with always-include semantics and survive compression.
- **Add it to SIDECAR.md**: for project-level conventions, the right place is SIDECAR.md.
- **Re-state the constraint**: typing a key instruction at the start of a new message reinforces it for the current turn.

### How do I pin specific context to every agent turn?

Three ways:

1. **Settings**: add paths to `sidecar.pinnedContext` — e.g. `["src/types.ts", "src/agent/"]`.
2. **Inline**: type `@pin:src/types.ts` anywhere in a chat message to toggle that file in.
3. **Pinned memory**: use `/memories` in chat or the Pinned Memory sidebar to pin text notes or file snippets that persist across sessions and survive context compression.

Pinned files appear in a dedicated "Pinned Files" section above relevance-scored context. See [configuration — context pinning](configuration#context-pinning).

### What is the Project Knowledge Index?

The Project Knowledge Index is a symbol-level semantic search layer built on tree-sitter parsing and MiniLM-L6-v2 embeddings. Every function, class, and method in the workspace is indexed at the symbol level. The agent's `project_knowledge_search` tool queries this index to find relevant code even when the symbol name does not appear in the query text — "where is auth handled?" returns `requireAuth` plus callers up to 2 graph hops away.

Enabled by default. Disable with `sidecar.projectKnowledge.enabled: false` to stop background indexing on very large codebases. See [configuration — retrieval](configuration#retrieval--project-knowledge-advanced).

---

## Safety & Privacy

### Does SideCar send my code to the cloud?

It depends on which backend you configure. If you use **Ollama** or **Kickstand**, all inference runs locally — no code leaves your machine. If you configure a cloud backend (Anthropic, OpenAI, OpenRouter, Groq, Fireworks), your code and conversation are sent to that provider's API under their data handling terms.

SideCar itself has no cloud component. There is no telemetry, no account, and no central server. The only network traffic is the API requests you configure.

### Can I review all changes before they hit disk?

Yes. Set `sidecar.agentMode: "review"`. In review mode, every `write_file` and `edit_file` call is buffered into an in-memory pending store. Nothing is written to disk until you explicitly accept it via the Pending Agent Changes panel or `SideCar: Accept All Pending Changes`. Each file's diff opens in VS Code's native diff editor when you click it.

In the default **cautious** mode, writes open a side-by-side diff editor immediately and wait for your Accept/Reject before proceeding. See [agent mode — review mode](agent-mode#review-mode--batch-diff-review).

### Is SideCar safe for air-gapped or corporate environments?

Yes, with the right configuration:

- Use a local backend (Ollama or Kickstand) so no inference traffic leaves the network.
- Set `sidecar.deps.checkVulnerabilities: false` to disable the OSV vulnerability API call.
- Set `sidecar.skills.offline: true` to disable skill registry sync.
- Use `.sidecarignore` to exclude sensitive files from context indexing.
- The macOS Seatbelt sandbox (`sidecar.sandbox.enabled`, default on) restricts agent shell commands to the workspace root, `/tmp`, and common build caches.

The outbound allowlist (`sidecar.outboundAllowlist`) lets you whitelist specific hostnames if you operate a private web search or documentation proxy.

### Can the agent run arbitrary shell commands?

The agent's `run_command` tool can execute shell commands — this is necessary for running tests, builds, and linters. In **cautious** and **manual** modes, every `run_command` call pops a blocking modal requiring your approval before execution. In **autonomous** mode, commands run without prompting. The macOS Seatbelt sandbox wraps every agent shell command regardless of agent mode, restricting write paths at the OS level.

To block shell execution entirely, set `"run_command": "deny"` and `"run_tests": "deny"` in `sidecar.toolPermissions`.

### How are my API keys stored?

API keys are stored in **VS Code SecretStorage** — backed by macOS Keychain, Windows Credential Manager, or libsecret on Linux. They are never written to `settings.json`. If you previously had a key in `settings.json`, SideCar migrates it to SecretStorage on first activation and clears the plaintext value. See [configuration — API key storage](configuration#api-key-storage-secretstorage).

---

## Cost & Performance

### How much does SideCar cost?

SideCar the extension is free. Running it against **Ollama** or **Kickstand** is also free — inference runs locally on your hardware. Cloud backends (Anthropic, OpenAI, OpenRouter, etc.) charge at the provider's standard API rates. SideCar does not add a markup.

Note: an Anthropic Claude Max or Pro subscription does **not** include API credits. Those are separate. Get API credits at [platform.claude.com](https://platform.claude.com).

### How do I track and limit my API spending?

- **Status bar**: the `$(credit-card) $0.12` item appears the moment a paid backend incurs cost. Click it for a per-model breakdown.
- **Session summary**: run `SideCar: Show Session Spend` or type `/usage`.
- **Daily/weekly budgets**: set `sidecar.dailyBudget` or `sidecar.weeklyBudget` in USD. Agent runs warn at 80% usage and are blocked at 100%.
- **Verbose logs**: set `sidecar.verboseLogs: true` to append per-turn cost metadata to `.sidecar/logs/api.jsonl`.

See [configuration — spending budgets](configuration#spending-budgets).

### How do I speed up a slow agent?

Options depending on the bottleneck:

- **Slow model inference**: switch to a smaller or faster model. Use `sidecar.editorModel` to route execution turns to a cheaper model while keeping a frontier model for planning.
- **Slow local model loading**: Kickstand keeps models warm in GPU memory between calls. Ollama unloads models after 5 minutes of inactivity — loading adds latency to the first request of a session.
- **Context too large**: reduce `sidecar.maxFiles`, lower `sidecar.streamingReadThreshold`, or use `.sidecarignore` to exclude irrelevant directories.
- **Too many file-read tool calls**: enable `sidecar.delegateTask.enabled` so the frontier model offloads codebase reads to a free local worker and only reasons over the compact summary.
- **Slow inline completions**: enable speculative decoding (`sidecar.speculativeDecoding.enabled: true`) with a small draft model (e.g. `sidecar.completionDraftModel: "qwen2.5-coder:0.5b"`).
- **Many files to write in one task**: the multi-file edit planner writes independent files in parallel (up to `sidecar.multiFileEdits.maxParallel`, default 8). Raise this cap for wide refactors.

---

## Teams & Sharing

### How do I share settings across a team?

Commit a `.vscode/settings.json` to the repository with the `sidecar.*` settings the team should share. Workspace settings in `.vscode/settings.json` take precedence over user settings and are version-controlled.

API keys are **never** stored in `settings.json` — they live in each developer's OS keychain. Each developer runs `SideCar: Set / Refresh API Key` once after cloning. See [configuration — API key storage](configuration#api-key-storage-secretstorage).

### How do I share custom skills with my team?

Skills are `.agent.md` files distributed via a git repository. Set up a team skill registry:

1. Create a git repo with your `.agent.md` skill files.
2. Add the repo URL to `sidecar.skills.teamRegistries` in `.vscode/settings.json`.
3. SideCar clones and syncs the registry on activation. The Skills Picker tags each skill by origin.

`sidecar.skills.autoPull` controls sync frequency (`"on-start"` or `"manual"`). For air-gapped teams, set `sidecar.skills.offline: true` after the initial clone. See [configuration — skills registry & sync](configuration#skills-registry--sync-v0112).

### How do I share custom facets with the team?

Commit facet markdown files to `<workspace>/.sidecar/facets/*.md`. SideCar loads these automatically for every developer who opens the workspace. Facets with an `id` matching a built-in override the built-in. See [extending SideCar — facets](extending-sidecar#facets) for the YAML frontmatter schema.

### How do I share SIDECAR.md with the team?

Commit it to the repository. The `.sidecar/` top-level directory is tracked in git — `SIDECAR.md` and other curated shared files belong there or at the workspace root. Ephemeral subdirectories (`cache/`, `memory/`, `sessions/`, `logs/`, `shadows/`) are gitignored and should not be committed.

### Does SideCar work in Dev Containers or remote SSH?

Yes. The extension installs in the container's extension host and agent shell commands execute inside the container. Remote SSH and WSL are supported via the same shell-integration routing. The macOS Seatbelt sandbox only activates on macOS hosts and is a no-op in Linux containers.

### Can the team use a shared self-hosted Ollama or Kickstand instance?

Yes. Point `sidecar.baseUrl` at the shared server's URL and set `sidecar.provider` to `"ollama"` or `"kickstand"` accordingly. For Kickstand, each developer needs the bearer token in their local `~/.config/kickstand/token`. This setup works well for teams where GPU hardware is centralised — developers connect from laptops without needing local GPUs.
