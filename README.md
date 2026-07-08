<p align="center">
  <img src="media/SideCar.png" alt="SideCar Logo" width="200">
</p>

# SideCar — AI Coding Assistant for VS Code

[![VS Code Marketplace](https://badgen.net/vs-marketplace/v/nedonatelli.sidecar-ai)](https://marketplace.visualstudio.com/items?itemName=nedonatelli.sidecar-ai)

**SideCar** is a free, self-hosted VS Code extension that serves as a drop-in replacement for GitHub Copilot and Claude Code. Use local [Ollama](https://ollama.com) models, the [Anthropic API](https://api.anthropic.com), [OpenAI](https://platform.openai.com), [Fireworks AI](https://fireworks.ai), [OpenRouter](https://openrouter.ai), [Google Gemini](https://aistudio.google.com), [Groq](https://groq.com), [Kickstand](https://github.com/nedonatelli/kickstand) (self-hosted), or any OpenAI-compatible server (LM Studio, vLLM, llama.cpp) for AI-powered coding — with full agentic capabilities, inline completions, and tool use.

A free, open-source, local-first **autonomous AI agent for coding** — a full agent loop, not just chat. No subscription, and with local models, no data leaves your machine.

## Why SideCar?

Agent mode, tool use, and MCP are table stakes in 2026 — Copilot, Cursor, Claude Code, Cline, and Continue all have them. What still sets SideCar apart is the combination underneath: **genuinely free and fully local-first** (runs offline on Ollama, no required cloud), a **scaffolding harness that makes weaker local models usable**, deep **native VS Code integration**, and a **safety/parallelism stack** (shadow workspaces, audit mode, fork & parallel solve, facets) — without a subscription.

### vs. open-source agents

SideCar's closest competitors are the other free, open-source agentic extensions: **[Cline](https://cline.bot)**, **[Kilo Code](https://kilo.ai)** (the Cline/Roo hybrid most Roo users adopted after [Roo Code shut down in May 2026](https://github.com/RooCodeInc/Roo-Code)), and **[Continue](https://continue.dev)** (now a full agent, not just autocomplete). SideCar and all three run local models offline, support MCP, and ship a project-rules file — so agent mode itself is no longer a differentiator. The honest differences (verified June 2026):

**Where SideCar is different**

- **Inline completions** — SideCar has Copilot-style FIM autocomplete built in; Cline and Kilo are agent-only (their users run a separate completion tool). Continue has its own completions too.
- **Local-model scaffolding harness** — capability-adaptive gates and reprompt budgets (Verify / Adapt / Orchestrate / Measure) plus an ablation harness (`npm run eval:ablation`) to make _weaker_ local models usable. The others assume a capable model; none has an equivalent.
- **Parallelism & write-isolation infra** — shadow workspaces (ephemeral git worktree), audit mode (in-memory write buffer), fork & parallel solve (N attempts, pick-the-winner), typed sub-agent facets, and a local model arena with ELO.
- **Deep VS Code integration** — Problems-panel security/diagnostics, Test Explorer agent runs, CodeLens actions, file decorations, and an activity-bar review badge.

**Where they're ahead**

- **Reach** — Cline and Kilo run across multiple editors (JetBrains, Zed, Cursor, …) plus CLI/SDK; SideCar is VS Code-only.
- **Ecosystem & maturity** — much larger communities, MCP/plugin marketplaces, and (Cline/Kilo) an optional managed pay-as-you-go provider.

> **Different form factor:** [Aider](https://aider.chat) and [Goose](https://github.com/block/goose) are strong open-source agents too, but they're **terminal/CLI** tools (Aider is git-native; Goose is CLI + desktop), not VS Code extensions — a different workflow rather than a head-to-head. Pure-autocomplete extensions like Twinny do single-line completion only; SideCar does that plus the full agent. (Llama Coder, the old Ollama-autocomplete option, appears unmaintained as of 2026.)

### vs. proprietary tools

These are all capable paid agents now — Copilot, Cursor, and Claude Code each ship agent mode and MCP. The comparison is no longer "agentic or not"; it's **local-first, IDE-native, and free** vs. cloud-tied and subscription-based.

| Capability                                    | SideCar                   | Copilot              | Cursor             | Claude Code               |
| --------------------------------------------- | ------------------------- | -------------------- | ------------------ | ------------------------- |
| Autonomous agent loop                         | Yes                       | Yes                  | Yes                | Yes                       |
| Model agnostic (any provider)                 | **Yes**                   | Partial              | Partial            | No                        |
| Fully offline / self-hosted                   | **Yes**                   | No                   | No                 | No                        |
| HuggingFace model install                     | **Yes**                   | No                   | No                 | No                        |
| Custom skills system                          | **Yes**                   | Yes                  | Yes (.cursorrules) | Yes                       |
| Context compaction (manual + auto)            | **Yes**                   | Yes                  | Yes                | Yes                       |
| Spending budgets & cost tracking              | **Yes**                   | Yes                  | Yes                | Yes                       |
| Hybrid local-worker delegation                | **Partial**               | No                   | No                 | No                        |
| Prompt pruner & pre-request caching           | **Yes**                   | No                   | No                 | Partial                   |
| Plan-then-execute mode                        | **Yes**                   | Yes                  | Yes                | Yes                       |
| Review mode (batch diff review)               | **Yes**                   | No                   | Partial            | No                        |
| Native Problems panel integration             | **Yes**                   | No                   | No                 | No                        |
| Test Explorer integration (agent test runs)   | **Yes**                   | No                   | No                 | No                        |
| Inline diff streaming in chat                 | **Yes**                   | No                   | No                 | No                        |
| Status bar health indicator                   | **Yes**                   | Partial              | No                 | No                        |
| Getting-started walkthrough                   | **Yes**                   | Yes                  | No                 | No                        |
| Native modal approval for destructive tools   | **Yes**                   | Partial              | Partial            | Partial                   |
| Conversation steering (type while processing) | **Yes**                   | No                   | Yes                | Yes                       |
| Works in your existing VS Code                | **Yes**                   | Yes                  | No (fork)          | Yes (extension + CLI)     |
| MCP support                                   | **Yes** (client + server) | Yes                  | Yes                | Yes                       |
| Monthly subscription                          | **Free**                  | Free tier; $10–39/mo | from $20/mo        | Usage-based / from $20/mo |

> Cursor is a standalone VS Code fork; **Windsurf** — the other major AI IDE — was rebranded to **Devin Desktop** by Cognition in 2026. Both are paid editors you switch _into_; SideCar (like Copilot, Cline, and Continue) runs inside the VS Code you already use.

### What sets SideCar apart

- **Free & fully local-first** — runs entirely offline on local Ollama models with no API key, no required cloud, and no subscription. Plug in Anthropic / OpenAI / AWS Bedrock / etc. only when you _want_ a frontier model.
- **Built for weaker local models** — a capability-adaptive scaffolding harness (grounded review + citation gates, tiered reprompt budgets, write/rewrite-thrash defenses) with an ablation harness (`npm run eval:ablation`) to keep only the scaffolds that earn their latency. This is the differentiator most agents lack — they assume a capable model.
- **Parallelism & write-isolation** — shadow workspaces (ephemeral git worktree), audit mode (atomic in-memory flush), fork & parallel solve (N attempts, pick the winner), typed sub-agent facets, and a local model arena with ELO.
- **Feels first-party** — status bar health indicator, native error toasts, lightbulb code actions, Problems-panel integration, file decorations, activity-bar badge, Test Explorer agent runs, and a `SideCar:` command palette category.
- **No vendor lock-in** — Ollama, Anthropic, AWS Bedrock, OpenAI-compatible (LM Studio, vLLM, OpenRouter), Kickstand, Groq, Fireworks, Gemini, Copilot, or GGUF directly from HuggingFace.
- **Hybrid cost-aware** — Anthropic prompt caching + 90%-reduction prompt pruner + `delegate_task` to a local Ollama worker + session spend tracker + daily/weekly budgets + architect/editor model split (`sidecar.editorModel`) that auto-routes execution turns to a faster/cheaper model.
- **Security from the ground up** — OS keychain key storage, secrets detection, vuln scanning, path-traversal protection, workspace hook warnings, macOS Seatbelt sandbox for agent shell commands.
- **Agentic across six modes** — cautious / autonomous / manual / plan / review / audit, with Copilot-style inline completions and MCP (client **and** server) on top.
- **Extensible** — MCP (stdio / HTTP / SSE) with lazy tool-schema loading (~50% less context per server) and round-trip write verification, custom skills via markdown, 11 built-in skills, NoSQL quick-install for MongoDB + Redis.

## Features

| Feature                             | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **86 built-in tools**               | File ops, shell, git, web search, database (SQLite/PG/MySQL/DuckDB), screenshot, doc-to-test synthesis, code profiling, LaTeX compilation, MCP task delegation, research assistant, CI failure analysis, change-impact analysis, numerical-contract checking, and more — [full list](https://nedonatelli.github.io/sidecar/tools)                                                                                                                                                                                                                                                    |
| **Review / Audit modes**            | Buffer all writes in-memory; review per-file diffs before anything touches disk. Audit adds atomic flush + deletion coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Shadow Workspaces**               | Run tasks in an ephemeral `git worktree` — main tree untouched until you accept                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Typed Sub-Agent Facets**          | Dispatch named specialists (`test-author`, `security-reviewer`, etc.) in parallel, each with its own tool allowlist and preferred model                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Fork & Parallel Solve**           | `/fork <task>` runs N parallel agent approaches; pick-the-winner review UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **NotebookLM research mode**        | `/notebook` — source-grounded chat with mandatory inline citations and five study-aid generators                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Project Knowledge Index**         | Semantic search over every function/class in your workspace via tree-sitter + MiniLM embeddings; chunk-level retrieval for prose docs                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Change-impact analysis**          | A consequence-aware code graph (AST-exact call/type-flow edges for TS + Python). `analyze_impact` answers "what depends on this symbol?" — import-resolved callers, type-users, subtypes, importers. Opt-in `sidecar.codeGraph.impactGate` blocks finishing with unverified cross-file dependents                                                                                                                                                                                                                                                                                    |
| **Numerical-correctness contracts** | For scientific Python: `check_numerical_contracts` finds array kernels (`np.ndarray`/`NDArray`/tensors) lacking a shape/dtype contract; `check_shape_consistency` propagates shape specs (jaxtyping/nptyping/numpy) and flags provable conflicts — intra-kernel, tail-call, and cross-call dataflow. Opt-in `sidecar.numericalContracts.gate` turns "tests pass" into "the array contracts are stated"                                                                                                                                                                               |
| **Active file context bar**         | Pill above the chat input — one click includes or excludes the currently open file from agent context                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Adversarial Critic**              | Second LLM call after every edit that finds bugs, regressions, and security issues — blocks the turn on high-severity findings                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Completion gate**                 | Blocks the agent from declaring done until lint and colocated tests for edited files have actually run — gates run via the agent's real execution path and key on output evidence, not exit codes                                                                                                                                                                                                                                                                                                                                                                                    |
| **Local-model scaffolding harness** | Capability-adaptive machinery that makes weaker local models usable: grounded review + citation-resolution gates, constrained-decoding repair of malformed tool calls, capability-tiered reprompt/critic/compression budgets (weak models get more help, strong models run lean), read-only specialist routing, and write/rewrite-thrash defenses. A failure taxonomy buckets every run (`malformed-call` / `wrong-tool` / `timeout` / `incomplete` / `bad-reasoning`) and `npm run eval:ablation` measures each scaffold's pass-rate lift vs. latency so pure-tax scaffolds get cut |
| **SIDECAR.md**                      | Path-scoped project instructions — sections inject only when the active file matches their `@paths` glob; per-directory files cascade root-to-leaf; falls back to `AGENTS.md` / `CLAUDE.md` / `.cursorrules` when no SIDECAR.md is present                                                                                                                                                                                                                                                                                                                                           |
| **DESIGN.md**                       | Always-injected architecture / style guide — place `.sidecar/DESIGN.md` (or `DESIGN.md`) to keep domain knowledge in every system prompt without SIDECAR.md boilerplate                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Inline completions**              | Copilot-style autocomplete via Ollama FIM or Anthropic (opt-in via `sidecar.enableInlineCompletions`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Inline chat**                     | `Cmd+I` — edit code in place; lightbulb integration surfaces **Fix / Explain / Refactor** on diagnostics                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Model Arena**                     | `/arena` opens a side-by-side panel comparing 2–4 models on the same prompt with live ELO ratings; `/arena agent` runs a task through different models via fork dispatch                                                                                                                                                                                                                                                                                                                                                                                                             |
| **RAM/VRAM monitor**                | Live status bar item shows free RAM % and GPU % (colour-coded); warns or blocks before Kickstand model loads, HuggingFace installs, and arena sessions when memory is critically low. Click to refresh, or `sidecar.memory.refresh` command                                                                                                                                                                                                                                                                                                                                          |
| **Selective regeneration**          | Select any text in an assistant response → a bar appears to rewrite just that section with optional instruction, in-place                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Background agents**               | `/bg <task>` spawns parallel autonomous agents with a status dashboard; toast notification + status bar spinner on completion                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **External context providers**      | Pull live GitHub Issues, Linear, Jira, or Bitbucket Cloud tickets into every agent system prompt via `sidecar.contextProviders`                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **CI Failure Analysis**             | `analyze_ci_failure` agent tool + `/ci` slash command parses failing GitHub Actions logs, windows the relevant error region, and proposes a fix. Gated by `sidecar.ciAnalysis.enabled`                                                                                                                                                                                                                                                                                                                                                                                               |
| **Regression Guards**               | `/guards` slash command + `RegressionGuardHook` runs ecosystem-aware post-edit checks (`lint-clean`, `tests-pass`, `no-new-todos`). Declare per-skill guards via `guards:` frontmatter                                                                                                                                                                                                                                                                                                                                                                                               |
| **Monorepo Support**                | `monorepo_packages` tool auto-detects Nx / Turbo / pnpm workspaces / Yarn / Lerna and lists workspace packages with metadata. Gated by `sidecar.monorepo.enabled`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **macOS Seatbelt sandbox**          | `sidecar.sandbox.enabled` wraps agent shell commands with a deny-default SBPL profile — writes restricted to the workspace + `/tmp` + build caches                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Dependency Drift Alerts**         | Scans `package.json`, `requirements.txt`, `Cargo.toml`, and `go.mod` for outdated and vulnerable deps — CVE/GHSA IDs from the OSV API surface in the Problems panel; `check_dependencies` agent tool for on-demand reports                                                                                                                                                                                                                                                                                                                                                           |
| **Test Current Model**              | `sidecar.testCurrentModel` runs the smoke eval suite against the active model, shows a progress notification, and reports pass/fail counts — **Open Report** button opens structured per-case failure details                                                                                                                                                                                                                                                                                                                                                                        |
| **Security scanning**               | Secrets, SQL injection, XSS, eval — findings in VS Code Problems panel (`source:sidecar-*`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Doc sync**                        | Checks JSDoc `@param` staleness and README call-site arity on every save                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **MCP**                             | stdio / HTTP / SSE transports, per-server tool allowlist, `sidecar.noSql.install` for one-click MongoDB + Redis                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Skills 2.0**                      | Constrained skills: `allowed-tools`, `preferred-model`, `max-iterations`, and `disable-model-invocation` frontmatter fields enforce execution contracts per skill; 🛡 badge in QuickPick for restricted skills                                                                                                                                                                                                                                                                                                                                                                       |
| **Skills Registry & Sync**          | `/skills` opens a searchable QuickPick with registry-origin tags, tool-allowlist chips, and Stack mode for composing skills. `SideCar: Publish Skill to Registry` commits and pushes a skill to your git registry. `SideCar: Sync Skill Registries` pulls without restart. `hourly`/`daily` autoPull for background sync                                                                                                                                                                                                                                                             |
| **Chat Threads & Branching**        | `/branch [name]` forks the current conversation — original preserved, branch continues independently; nested parent/child tree in the Sessions sidebar                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Research Assistant**              | Structured project tracking: 8 agent tools (`research_create_project`, `_add_hypothesis`, `_log_experiment`, `_add_observation`, `_update_hypothesis_status`, `_set_project_status`, `_list_projects`, `_export_report`) + sidebar panel + `/research` slash command. Gated by `sidecar.research.enabled`                                                                                                                                                                                                                                                                            |
| **Context window bar**              | 3 px colour-coded fill bar above the input area — blue → yellow (≥ 60 %) → red (≥ 80 %). Tooltip shows `Context: 12K / 32K tokens (38%)`                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Message editing**                 | Click ✎ on any user message to edit and resend — subsequent messages fade out as a truncation preview, then history is rewound and the agent re-runs with the edited text                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Skills**                          | 11 built-in skills (review-code, debug, refactor, write-tests, break-this, explain-code, create-skill, mcp-builder, tdd-red-green-refactor, typed-service-contracts, agent-dx-cli-scale) + custom markdown skills                                                                                                                                                                                                                                                                                                                                                                    |
| **Slash commands**                  | `/model`, `/fork`, `/branch`, `/compact`, `/notebook`, `/bg`, `/pr`, `/review`, `/ci`, `/memories`, `/commit`, `/doc`, `/spec`, `/revise`, and 25+ more with autocomplete                                                                                                                                                                                                                                                                                                                                                                                                            |

## Requirements

- **Visual Studio Code** 1.88.0 or later
- **[Ollama](https://ollama.com)** installed and in your PATH (for local models only)

## Getting Started

### Ollama (local, free)

1. Install [Ollama](https://ollama.com) if you haven't already
2. Install the SideCar extension
3. Click the SideCar icon in the activity bar
4. Start chatting — SideCar launches Ollama automatically and downloads a starter model

**Default model: `gemma4:e4b`** (9 GB, ~10 GB VRAM — the most-dogfooded local model, with the strongest prompt-following of those tested and a cold-start the harness handles automatically). Lighter alternative: `ministral-3:latest` (6 GB, 8 GB VRAM, highest agent eval at 98%). Low-RAM: `granite4.1:3b` (2 GB, 81%). Cloud: configure the Anthropic backend for maximum reliability.

### Anthropic (Claude)

1. Click the ☰ menu in the chat header → **Anthropic Claude** under Backend
2. SideCar prompts for your API key on first switch — paste it and you're done

Or manually: `sidecar.baseUrl` = `https://api.anthropic.com`, run `SideCar: Set / Refresh API Key`, set `sidecar.model` = `claude-sonnet-4-6`.

SideCar uses Anthropic's prompt caching automatically — subsequent turns in a session cost ~90% less on input tokens.

### OpenAI

1. Set `sidecar.baseUrl` to `https://api.openai.com`
2. Run `SideCar: Set / Refresh API Key` and paste your OpenAI key
3. Set `sidecar.model` to `gpt-5` (recommended — higher TPM than mini models)

> **Note:** `gpt-4o-mini` and `gpt-4.1-mini` share a 200K TPM org-level cap. At ~23K tokens per request (system prompt + tools), the budget exhausts after ~8 requests. Use `gpt-5` or a model with a higher TPM allocation.

### Fireworks AI

Fireworks offers fast inference for large open-source models including DeepSeek and Llama variants.

1. Set `sidecar.baseUrl` to `https://api.fireworks.ai/inference`
2. Run `SideCar: Set / Refresh API Key` and paste your Fireworks key
3. Set `sidecar.model` to `accounts/fireworks/models/deepseek-v4-pro` (recommended)

### OpenRouter

OpenRouter provides a single API key for 100+ models across providers.

1. Set `sidecar.baseUrl` to `https://openrouter.ai/api`
2. Run `SideCar: Set / Refresh API Key` and paste your OpenRouter key
3. Set `sidecar.model` to e.g. `x-ai/grok-3-mini` or `google/gemini-2.5-flash`

### Google Gemini

1. Set `sidecar.baseUrl` to `https://generativelanguage.googleapis.com/v1beta/openai`
2. Run `SideCar: Set / Refresh API Key` and paste your Gemini API key
3. Set `sidecar.model` to `gemini-2.5-flash`

### Groq

Groq offers very fast inference for open-source models via their LPU hardware.

1. Set `sidecar.baseUrl` to `https://api.groq.com/openai`
2. Run `SideCar: Set / Refresh API Key` and paste your Groq key
3. Set `sidecar.model` to e.g. `llama-3.3-70b-versatile`

> **Note:** Groq's free tier (12K–30K TPM) is exhausted after 1–2 requests from SideCar's system prompt + tool schemas. A paid tier is required for reliable use.

### Kickstand (self-hosted manager)

[Kickstand](https://github.com/nedonatelli/kickstand) is a self-hosted model manager that wraps Ollama with a management API, model registry, and load/unload controls.

1. Run Kickstand locally — it auto-generates a bearer token at `~/.config/kickstand/token`
2. Set `sidecar.baseUrl` to your Kickstand URL (default `http://localhost:4000`)
3. SideCar reads the token file automatically — no API key prompt needed

### Other OpenAI-compatible servers

LM Studio, vLLM, llama.cpp, and other OpenAI-compatible servers work out of the box:

1. Set `sidecar.baseUrl` to your server URL (e.g. `http://localhost:1234`)
2. Set `sidecar.model` to the model name on your server
3. Run `SideCar: Set / Refresh API Key` if your server requires authentication

SideCar auto-detects the provider from the URL. Override with `sidecar.provider: "openai"` if needed.

## Tested Models

SideCar is verified against an agent smoke-eval suite (read / edit / write / run / plan / error-recovery tasks) on each supported model. The primary gate is **infrastructure reliability** — the agent loop, tool-call parsing, and completion gates must run cleanly (no crashes, dropped tool calls, or retry thrash) — measured separately from a model's raw task capability.

**Test hardware:** Apple M3 Max, 36 GB unified memory (macOS), Ollama for local models. Model sizes and memory guidance below assume this configuration.

### Local models (Ollama)

Every model below runs the agent smoke suite with **zero infrastructure errors**. Task-completion capability varies; the recommendations reflect both.

| Model                     | Size   | Notes                                                                     |
| ------------------------- | ------ | ------------------------------------------------------------------------- |
| **gemma4:e4b** (default)  | 9.6 GB | Strongest prompt-following of the local models; the shipped default       |
| **ministral-3:latest**    | 6.0 GB | Lightest strong agent; recommended low-footprint default                  |
| **qwen2.5-coder:7b**      | 4.7 GB | Reliable coding baseline — the most consistent tool-caller of the 7B tier |
| **qwen3-coder:30b**       | 18 GB  | Best larger local coder (MoE, ~3.3B active); recommended if it fits       |
| qwen3.5:latest            | 6.6 GB | Reliable as of v0.116 (earlier versions hit Ollama tool-parser issues)    |
| deepseek-r1:8b / qwen3:8b | 5.2 GB | Reasoning models; answers surfaced correctly as of v0.116                 |
| granite4.1:3b             | 2.1 GB | Low-RAM option; punches above its weight                                  |
| llama3.2:latest           | 2.0 GB | Low-RAM general model                                                     |
| devstral:24b              | 14 GB  | SWE-tuned; supported as of v0.116 (`{tool, args}` text-call parsing fix)  |

**Memory guidance (36 GB).** Sub-10 GB models run comfortably alongside VS Code with headroom for the context cache. A 14B model at a large context window (e.g. `qwen2.5-coder:14b` with SideCar's full `num_ctx`) can exceed 36 GB of unified memory and thrash — lower `sidecar.ollama.numCtx`, or prefer the 7B coder. On more memory, the 24–30 GB-class models above have proportionally more room.

### Cloud models

For maximum reliability, the **Anthropic (Claude)**, **Google Gemini**, and **Fireworks (DeepSeek)** backends are the strongest tested cloud options; see the setup sections above.

## VS Code Copilot Chat & Agents Window

SideCar registers as a native VS Code chat participant — type `@sidecar` in the Copilot Chat panel to talk to your configured backend without opening the SideCar sidebar. Slash commands `/review`, `/fix`, `/explain`, and `/commit-message` are available.

**VS Code Agents Window (Preview):** To use SideCar in the dedicated [Agents Window](https://code.visualstudio.com/docs/copilot/agents/agents-window), add the following to your VS Code `settings.json`:

```json
"extensions.supportAgentsWindow": {
    "nedonatelli.sidecar-ai": true
}
```

The extension must be installed in your default VS Code profile.

## Keyboard Shortcuts

| Shortcut                       | Action                           |
| ------------------------------ | -------------------------------- |
| `Cmd+Shift+I` / `Ctrl+Shift+I` | Toggle SideCar chat panel        |
| `Cmd+I` / `Ctrl+I`             | Inline chat (edit code in place) |
| `Cmd+L` / `Ctrl+L`             | Clear chat                       |
| `Cmd+Shift+U` / `Ctrl+Shift+U` | Undo all AI changes              |
| `Cmd+Shift+E` / `Ctrl+Shift+E` | Export chat as Markdown          |

## Extension Settings

Core settings — full reference at [nedonatelli.github.io/sidecar/settings](https://nedonatelli.github.io/sidecar/settings).

| Setting                                | Default                  | Description                                                                              |
| -------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| `sidecar.baseUrl`                      | `http://localhost:11434` | API base URL                                                                             |
| `sidecar.model`                        | `gemma4:e4b`             | Model for chat                                                                           |
| `sidecar.agentMode`                    | `cautious`               | `cautious` / `autonomous` / `manual` / `plan` / `review` / `audit` or a custom mode name |
| `sidecar.agentMaxIterations`           | `50`                     | Max agent loop iterations                                                                |
| `sidecar.agentMaxTokens`               | `200000`                 | Max tokens per agent run                                                                 |
| `sidecar.mcpServers`                   | `{}`                     | MCP server definitions (or use `.mcp.json`)                                              |
| `sidecar.toolPermissions`              | `{}`                     | Per-tool overrides: `allow` / `deny` / `ask`                                             |
| `sidecar.hooks`                        | `{}`                     | Pre/post execution hooks per tool                                                        |
| `sidecar.completionGate.enabled`       | `true`                   | Block agent finish until lint + tests pass                                               |
| `sidecar.enableInlineCompletions`      | `false`                  | Copilot-style autocomplete (opt-in)                                                      |
| `sidecar.mcpDelegation.enabled`        | `false`                  | Enable `delegate_to_mcp` tool (agent → MCP server)                                       |
| `sidecar.mcpDelegation.allowedServers` | `[]`                     | Allowlist of servers `delegate_to_mcp` may target (empty = all)                          |
| `sidecar.mcpServer.enabled`            | `false`                  | Expose SideCar's agent loop as a local MCP server                                        |
| `sidecar.mcpServer.port`               | `3457`                   | Port for the SideCar MCP server (127.0.0.1 only)                                         |
| `sidecar.mcpServer.requireAuth`        | `false`                  | Require bearer token for inbound MCP requests                                            |
| `sidecar.dailyBudget`                  | —                        | Daily spend cap in USD (paid backends)                                                   |
| `sidecar.weeklyBudget`                 | —                        | Weekly spend cap in USD (paid backends)                                                  |

API keys are stored in VS Code SecretStorage (OS keychain) — set via `SideCar: Set / Refresh API Key`, never in plaintext settings.

## Documentation

Full documentation: [nedonatelli.github.io/sidecar](https://nedonatelli.github.io/sidecar/)

- **[SECURITY.md](SECURITY.md)** — threat model, secret-pattern catalog, vulnerability disclosure
- **[docs/extending-sidecar.md](docs/extending-sidecar.md)** — skills, custom tools, MCP servers, policy hooks
- **[CHANGELOG.md](CHANGELOG.md)** — per-release notes
- Architecture diagrams: [agent loop](docs/agent-loop-diagram.md) · [tool dispatch](docs/tool-system-diagram.md) · [context pipeline](docs/context-pipeline-diagram.md) · [MCP lifecycle](docs/mcp-lifecycle-diagram.md)

## Support & Contact

- **Bug reports & feature requests**: [GitHub Issues](https://github.com/nedonatelli/sidecar/issues)
- **Security issues**: private disclosure via [SECURITY.md](SECURITY.md) — please don't open public issues for vulnerabilities
- **Email**: [sidecarai.vscode@gmail.com](mailto:sidecarai.vscode@gmail.com)
- **Documentation**: [nedonatelli.github.io/sidecar](https://nedonatelli.github.io/sidecar/)

SideCar is free and always will be. If it saves you time and you'd like to support development, a tip is appreciated but never required:

<a href="https://www.buymeacoffee.com/nedonatelli" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-red.png" alt="Buy Me A Coffee" width="160" height="40"></a>

## Disclaimer

SideCar is an independent project by Nicholas Donatelli and is not affiliated with, endorsed by, or sponsored by Ollama, Anthropic, Meta, Mistral AI, Google, GitHub, or any other company. All product names are trademarks of their respective holders.

## License

[MIT](LICENSE)
