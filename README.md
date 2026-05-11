<p align="center">
  <img src="media/SideCar.png" alt="SideCar Logo" width="200">
</p>

# SideCar — AI Coding Assistant for VS Code

[![VS Code Marketplace](https://badgen.net/vs-marketplace/v/nedonatelli.sidecar-ai)](https://marketplace.visualstudio.com/items?itemName=nedonatelli.sidecar-ai)

**SideCar** is a free, self-hosted VS Code extension that serves as a drop-in replacement for GitHub Copilot and Claude Code. Use local [Ollama](https://ollama.com) models, the [Anthropic API](https://api.anthropic.com), [OpenAI](https://platform.openai.com), [Fireworks AI](https://fireworks.ai), [OpenRouter](https://openrouter.ai), [Google Gemini](https://aistudio.google.com), [Groq](https://groq.com), [Kickstand](https://github.com/nedonatelli/kickstand) (self-hosted), or any OpenAI-compatible server (LM Studio, vLLM, llama.cpp) for AI-powered coding — with full agentic capabilities, inline completions, and tool use.

> A free, open-source, local-first **autonomous AI agent for coding**. Full agent loop, not just chat. No subscriptions, no data leaving your machine.

SideCar will always be free, tips not required but appreciated.

<a href="https://www.buymeacoffee.com/nedonatelli" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-red.png" alt="Buy Me A Coffee" style="height: 20px !important;" ></a>

## Why SideCar?

Most local AI extensions for VS Code are **chat wrappers or autocomplete plugins**. SideCar is a **full agentic coding assistant** — closer to Claude Code or Cursor than to a chatbot, but free, open-source, and model-agnostic.

### vs. Local Extensions

| Capability | SideCar | Continue | Llama Coder | Twinny |
|---|---|---|---|---|
| Autonomous agent loop | **Yes** | Yes | Partial | No |
| File read/write/edit tools | **Yes** | Yes | Yes | No |
| Run commands & tests | **Yes** (persistent shell) | Yes | Yes | No |
| Web search | **Yes** (built-in) | Yes | Yes | No |
| Security & secrets scanning | **Yes** (Problems panel) | Partial | No | No |
| MCP server support | **Yes** | Yes | No | No |
| Git integration (commit, PR, releases) | **Yes** | Partial | No | No |
| Diff preview & undo/rollback | **Yes** | Yes | No | No |
| Plan mode | **Yes** | Yes | No | No |
| Review mode (accept/discard per file) | **Yes** | Partial | No | No |
| Pending-change file decorations | **Yes** | No | No | No |
| Activity-bar review badge | **Yes** | No | No | No |
| Native lightbulb code actions | **Yes** | Partial | No | No |
| Built-in skills (8) | **Yes** | Yes | No | No |
| Tree-sitter AST parsing | **Yes** | Yes | No | No |
| Codebase indexing | **Yes** | Yes | No | No |
| Spending budgets | **Yes** | No | No | No |
| Session spend tracker (status bar) | **Yes** | No | No | No |
| Hybrid cost-aware delegation | **Partial** | No | No | No |
| Getting-started walkthrough | **Yes** | No | No | No |
| Conversation steering (type while processing) | **Yes** | No | No | No |
| Free & open-source | Yes | Yes | Yes | Yes |

### vs. Pro Tools

| Capability | SideCar | Copilot | Cursor | Claude Code |
|---|---|---|---|---|
| Autonomous agent loop | Yes | Yes | Yes | Yes |
| Model agnostic (any provider) | **Yes** | Partial | Partial | No |
| Fully offline / self-hosted | **Yes** | No | No | No |
| HuggingFace model install | **Yes** | No | No | No |
| Custom skills system | **Yes** | Yes | Yes (.cursorrules) | Yes |
| Context compaction (manual + auto) | **Yes** | Yes | Yes | Yes |
| Spending budgets & cost tracking | **Yes** | Yes | Yes | Yes |
| Hybrid local-worker delegation | **Partial** | No | No | No |
| Prompt pruner & pre-request caching | **Yes** | No | No | Partial |
| Plan-then-execute mode | **Yes** | Yes | Yes | Yes |
| Review mode (batch diff review) | **Yes** | No | Partial | No |
| Native Problems panel integration | **Yes** | No | No | No |
| Status bar health indicator | **Yes** | Partial | No | No |
| Getting-started walkthrough | **Yes** | Yes | No | No |
| Native modal approval for destructive tools | **Yes** | No | No | Partial |
| Conversation steering (type while processing) | **Yes** | No | Yes | Yes |
| Works in your existing VS Code | **Yes** | Yes | No (fork) | Yes (extension + CLI) |
| Monthly subscription | **Free** | $10-39/mo | from $20/mo | Usage-based / from $20/mo |

### What sets SideCar apart

- **True agentic autonomy** — reads code, edits files, runs tests, and iterates until the task is done across cautious / autonomous / manual / plan / review / audit modes.
- **No vendor lock-in** — Ollama, Anthropic, OpenAI-compatible (LM Studio, vLLM, OpenRouter), Kickstand, or GGUF directly from HuggingFace.
- **Feels first-party** — status bar health indicator, native error toasts, lightbulb code actions, Problems panel integration, file decorations, activity-bar badge, and a `SideCar:` command palette category.
- **Hybrid cost-aware** — Anthropic prompt caching + 90%-reduction prompt pruner + `delegate_task` to a local Ollama worker + session spend tracker + daily/weekly budgets.
- **Security from the ground up** — OS keychain key storage, secrets detection, vuln scanning, path traversal protection, workspace hook warnings.
- **Extensible** — MCP (stdio / HTTP / SSE), custom skills via markdown, 8 built-in skills, NoSQL quick-install for MongoDB + Redis.
- **Production-grade safety** — review mode, audit mode (atomic flush), shadow workspaces, completion gate, cycle detection, stub validator, regression guards.

## Features

| Feature | Description |
|---|---|
| **61 built-in tools** | File ops, shell, git, web search, database (SQLite/PG/MySQL/DuckDB), screenshot, doc-to-test synthesis, and more — [full list](https://nedonatelli.github.io/sidecar/tools) |
| **Review / Audit modes** | Buffer all writes in-memory; review per-file diffs before anything touches disk. Audit adds atomic flush + deletion coverage |
| **Shadow Workspaces** | Run tasks in an ephemeral `git worktree` — main tree untouched until you accept |
| **Typed Sub-Agent Facets** | Dispatch named specialists (`test-author`, `security-reviewer`, etc.) in parallel, each with its own tool allowlist and preferred model |
| **Fork & Parallel Solve** | `/fork <task>` runs N parallel agent approaches; pick-the-winner review UI |
| **NotebookLM research mode** | `/notebook` — source-grounded chat with mandatory inline citations and five study-aid generators |
| **Project Knowledge Index** | Semantic search over every function/class in your workspace via tree-sitter + MiniLM embeddings; chunk-level retrieval for prose docs |
| **Active file context bar** | Pill above the chat input — one click includes or excludes the currently open file from agent context |
| **Adversarial Critic** | Second LLM call after every edit that finds bugs, regressions, and security issues — blocks the turn on high-severity findings |
| **Completion gate** | Blocks the agent from declaring done until lint and colocated tests for edited files have actually run |
| **SIDECAR.md** | Path-scoped project instructions — sections inject only when the active file matches their `@paths` glob |
| **Inline completions** | Copilot-style autocomplete via Ollama FIM or Anthropic (opt-in via `sidecar.enableInlineCompletions`) |
| **Inline chat** | `Cmd+I` — edit code in place; lightbulb integration surfaces **Fix / Explain / Refactor** on diagnostics |
| **Background agents** | `/bg <task>` spawns parallel autonomous agents with a status dashboard |
| **Security scanning** | Secrets, SQL injection, XSS, eval — findings in VS Code Problems panel (`source:sidecar-*`) |
| **Doc sync** | Checks JSDoc `@param` staleness and README call-site arity on every save |
| **MCP** | stdio / HTTP / SSE transports, per-server tool allowlist, `sidecar.noSql.install` for one-click MongoDB + Redis |
| **Skills** | 8 built-in skills (review-code, debug, refactor, write-tests, break-this, explain-code, create-skill, mcp-builder) + custom markdown skills |
| **Slash commands** | `/model`, `/fork`, `/notebook`, `/bg`, `/pr`, `/review`, `/ci`, `/memories`, `/commit`, `/doc`, `/spec`, `/revise`, and 25+ more with autocomplete |

## Requirements

- **Visual Studio Code** 1.88.0 or later
- **[Ollama](https://ollama.com)** installed and in your PATH (for local models only)

## Getting Started

### Ollama (local, free)

1. Install [Ollama](https://ollama.com) if you haven't already
2. Install the SideCar extension
3. Click the SideCar icon in the activity bar
4. Start chatting — SideCar launches Ollama automatically and downloads a starter model

Recommended models: `qwen3-coder:30b` (coding), `gemma4:e4b` (fast + accurate), `ministral-3:latest` (best agentic score at 6 GB)

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

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+I` / `Ctrl+Shift+I` | Toggle SideCar chat panel |
| `Cmd+I` / `Ctrl+I` | Inline chat (edit code in place) |
| `Cmd+L` / `Ctrl+L` | Clear chat |
| `Cmd+Shift+U` / `Ctrl+Shift+U` | Undo all AI changes |
| `Cmd+Shift+E` / `Ctrl+Shift+E` | Export chat as Markdown |

## Extension Settings

Core settings — full reference at [nedonatelli.github.io/sidecar/settings](https://nedonatelli.github.io/sidecar/settings).

| Setting | Default | Description |
|---------|---------|-------------|
| `sidecar.baseUrl` | `http://localhost:11434` | API base URL |
| `sidecar.model` | `qwen3-coder:30b` | Model for chat |
| `sidecar.agentMode` | `cautious` | `cautious` / `autonomous` / `manual` / `plan` / `review` / `audit` or a custom mode name |
| `sidecar.agentMaxIterations` | `50` | Max agent loop iterations |
| `sidecar.agentMaxTokens` | `200000` | Max tokens per agent run |
| `sidecar.mcpServers` | `{}` | MCP server definitions (or use `.mcp.json`) |
| `sidecar.toolPermissions` | `{}` | Per-tool overrides: `allow` / `deny` / `ask` |
| `sidecar.hooks` | `{}` | Pre/post execution hooks per tool |
| `sidecar.completionGate.enabled` | `true` | Block agent finish until lint + tests pass |
| `sidecar.enableInlineCompletions` | `false` | Copilot-style autocomplete (opt-in) |
| `sidecar.dailyBudget` | — | Daily spend cap in USD (paid backends) |
| `sidecar.weeklyBudget` | — | Weekly spend cap in USD (paid backends) |

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

## Disclaimer

SideCar is an independent project by Nicholas Donatelli and is not affiliated with, endorsed by, or sponsored by Ollama, Anthropic, Meta, Mistral AI, Google, GitHub, or any other company. All product names are trademarks of their respective holders.

## License

[MIT](LICENSE)
