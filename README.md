<p align="center">
  <img src="media/SideCar.png" alt="SideCar Logo" width="200">
</p>

# SideCar — AI Coding Assistant for VS Code

[![VS Code Marketplace](https://badgen.net/vs-marketplace/v/nedonatelli.sidecar-ai)](https://marketplace.visualstudio.com/items?itemName=nedonatelli.sidecar-ai)
[![Installs](https://badgen.net/vs-marketplace/i/nedonatelli.sidecar-ai)](https://marketplace.visualstudio.com/items?itemName=nedonatelli.sidecar-ai)
[![License: MIT](https://badgen.net/github/license/nedonatelli/sidecar)](LICENSE)

**SideCar** is a free, open-source coding agent for VS Code: a full agent loop with tool use, inline completions and inline chat, not just a chat panel. Run it on local [Ollama](https://ollama.com) models with no API key and no data leaving your machine, or connect Anthropic, OpenAI, OpenRouter, Groq, Fireworks, Google Gemini, AWS Bedrock, your GitHub Copilot subscription, or any OpenAI-compatible server.

## Quick start

1. Install [Ollama](https://ollama.com) and pull the default model: `ollama pull gemma4:e4b`
2. Install the SideCar extension
3. Click the SideCar icon in the activity bar (or `Cmd+Shift+I` / `Ctrl+Shift+I`)
4. Start chatting. SideCar starts Ollama if it isn't running, and offers **Install Model** if the selected model is missing.

`gemma4:e4b` (9.6 GB, about 10 GB of VRAM) is the most-tested local model. On smaller GPUs, try `ministral-3:latest` (6 GB) or `granite4.1:3b` (2 GB).

### Other providers

Open the ☰ menu in the chat header → **Backend** (or run `SideCar: Switch Backend`) and pick a provider. SideCar sets the URL, provider and a default model, then asks for the API key and keeps it in the OS keychain, one slot per provider. Then pick the model you want with `SideCar: Select Model`.

| Provider                         | What you need                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| Anthropic, OpenAI, Google Gemini | An API key from the provider (billed separately from Claude.ai or ChatGPT plans)                    |
| OpenRouter, Fireworks            | An API key; one key reaches many models                                                             |
| Groq                             | An API key on a paid tier: one SideCar request is larger than the free tier's tokens-per-minute cap |
| AWS Bedrock                      | Your AWS credentials or a Bedrock API key, and model access enabled in the region                   |
| GitHub Copilot                   | The Copilot extension, signed in; no separate key                                                   |
| Custom endpoint                  | Any OpenAI-compatible server (vLLM, LM Studio, llama.cpp, a gateway) and its URL                    |

Setup, tuning and limits for each: [docs/backends.md](docs/backends.md).

## Features

The highlights. Full list: [feature specs](https://nedonatelli.github.io/sidecar/feature-specs).

| Feature                                       | Description                                                                                                                                                                                                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **87 built-in tools**                         | File ops, shell, git, web search, databases, screenshots, code profiling, CI-failure analysis, change-impact analysis, and more — [full list](https://nedonatelli.github.io/sidecar/tools-reference)                                                        |
| **Local-model scaffolding harness**           | Capability-adaptive machinery for weaker local models: tool-call recovery from model text, grounding/completion gates, tiered reprompt budgets, and a trimmed tool catalog for local backends. Net effect is [measured, not assumed](#measured-not-claimed) |
| **Completion gate**                           | Holds back "done" until lint and colocated tests have actually run, reading their output rather than trusting exit codes; failing tests get the agent sent back to fix them, and edited files must parse                                                    |
| **Write isolation**                           | Review/Audit modes (buffer writes in-memory, approve per-file diffs) and Shadow Workspaces (run in an ephemeral `git worktree`; main tree untouched until you accept)                                                                                       |
| **Safety checks**                             | Asks before commits that hold ignored or oversized files, before pushes (naming the remote and whether it's public), and before config changes you didn't ask for                                                                                           |
| **Parallelism**                               | Fork & parallel solve (N attempts, pick the winner), typed sub-agent facets (named specialists with their own tool allowlist + model), and background agents                                                                                                |
| **Durable instruction memory** _(A/B-proven)_ | Standing instructions survive context compaction and the session itself, applied automatically in later sessions; review or forget them in the **Remembered Instructions** view                                                                             |
| **Project knowledge & impact**                | Semantic search over every symbol (tree-sitter + embeddings) and an AST-exact code graph — `analyze_impact` answers "what depends on this symbol?"                                                                                                          |
| **Inline completions & chat**                 | Copilot-style FIM autocomplete and `Cmd+I` in-place editing with Fix/Explain/Refactor on diagnostics                                                                                                                                                        |
| **MCP (client + server)**                     | stdio / HTTP / SSE transports with lazy schema loading; expose SideCar's own agent loop as an MCP server                                                                                                                                                    |
| **Skills & project instructions**             | Markdown skills (`allowed-tools`, `preferred-model`, `max-iterations`) and 40+ slash commands; path-scoped `SIDECAR.md`, falling back to `AGENTS.md` / `CLAUDE.md` / `.cursorrules`                                                                         |
| **Cost controls**                             | Anthropic prompt caching, a pruner for oversized tool results, delegation to a local worker model, and daily/weekly spend caps                                                                                                                              |
| **VS Code integration**                       | Security and diagnostic findings in the Problems panel, agent runs from Test Explorer, CodeLens actions, and `@sidecar` in Copilot Chat                                                                                                                     |

## Why SideCar

- **Free and local-first.** Runs offline on Ollama with no account or key; add a cloud provider only when you want one. No subscription.
- **Works with local models that other agents can't drive.** Many capable local models write their tool calls as text or JSON in the reply instead of the structured field, so a stock agent sees no call and stalls. SideCar parses and runs them; `qwen2.5-coder`, for one, can't call tools at all without it.
- **Any provider, in the VS Code you already use.** Not a fork; switching provider is one menu pick, and you can install GGUF models from Hugging Face.

The trade-off: SideCar is VS Code-only, while Cline and Kilo Code cover more editors and have larger plugin ecosystems.

### Measured, not claimed

SideCar carries a lot of machinery meant to make weaker local models usable: gates, reprompt budgets, tool-call repair. Specific repairs are proven to matter (the text-call parsing above, for example). That the stack as a whole makes a local model better at real tasks is **not** established, and this README doesn't claim it. Mechanisms that measure net-negative are removed. The main gates can be switched off (`sidecar.completionGate.enabled`, `sidecar.syntaxGate.enabled`, `sidecar.redCheckGate.enabled`).

## Tested models

Each model below runs SideCar's agent smoke suite (read, edit, write, run, plan and error-recovery tasks) with zero infrastructure errors: no crashes, dropped tool calls or retry loops. How well each completes the tasks varies, and the notes reflect both.

| Model                    | Size   | Notes                                                                              |
| ------------------------ | ------ | ---------------------------------------------------------------------------------- |
| **gemma4:e4b** (default) | 9.6 GB | Strongest prompt-following of the local models; the shipped default                |
| **gemma4:31b**           | 20 GB  | The most capable local model tested; needs a 32 GB GPU                             |
| **ornith:9b**            | 5.6 GB | Best small-footprint agent — near-default capability at a third the size           |
| **ministral-3:latest**   | 6.0 GB | Strong, low-footprint, reliable                                                    |
| **qwen2.5-coder:7b**     | 4.7 GB | Solid coding baseline; emits text-form tool calls (SideCar's parser recovers them) |
| north-mini-code:1.0      | 19 GB  | Agentic-tuned coder; strong autonomous, but rarely asks clarifying questions       |
| laguna-xs-2.1            | 20 GB  | Fast MoE coder; some run-to-run variance                                           |
| granite4.1:3b            | 2.1 GB | Low-RAM option; punches above its weight                                           |
| llama3.2:latest          | 2.0 GB | Low-RAM general model; below the agent floor for complex tasks                     |

**Not recommended:** `lfm2.5`, which in testing reliably followed instructions planted in a code block (a prompt injection).

Memory and GPU guidance, and per-model detail: [Model Compatibility](docs/model-compatibility.md). In the cloud, Anthropic Claude and Google Gemini are the strongest tested options.

## Keyboard shortcuts

| Shortcut                       | Action                           |
| ------------------------------ | -------------------------------- |
| `Cmd+Shift+I` / `Ctrl+Shift+I` | Toggle SideCar chat panel        |
| `Cmd+I` / `Ctrl+I`             | Inline chat (edit code in place) |
| `Cmd+L` / `Ctrl+L`             | Clear chat                       |
| `Cmd+Shift+U` / `Ctrl+Shift+U` | Undo all AI changes              |
| `Cmd+Shift+E` / `Ctrl+Shift+E` | Export chat as Markdown          |

## Settings

The ones most people change. Every setting: [configuration reference](https://nedonatelli.github.io/sidecar/configuration).

| Setting                           | Default                  | Description                                                                          |
| --------------------------------- | ------------------------ | ------------------------------------------------------------------------------------ |
| `sidecar.model`                   | `gemma4:e4b`             | Model for chat and agent runs                                                        |
| `sidecar.baseUrl`                 | `http://localhost:11434` | API base URL                                                                         |
| `sidecar.agentMode`               | `cautious`               | `cautious` / `autonomous` / `manual` / `plan` / `review` / `audit`, or a custom mode |
| `sidecar.completionGate.enabled`  | `true`                   | Hold back "done" until lint and tests pass                                           |
| `sidecar.enableInlineCompletions` | `false`                  | Copilot-style autocomplete (opt-in)                                                  |
| `sidecar.dailyBudget`             | `0` (off)                | Daily spend cap in USD on paid backends (`sidecar.weeklyBudget` for weekly)          |

API keys live in VS Code SecretStorage (the OS keychain), set with `SideCar: Set / Refresh API Key`, never in `settings.json`.

**Agents Window (preview):** to use SideCar in VS Code's [Agents Window](https://code.visualstudio.com/docs/agents/run/agents-window), install it in your default profile and add to `settings.json`:

```json
"extensions.supportAgentsWindow": {
    "nedonatelli.sidecar-ai": true
}
```

## Documentation

Full documentation: [nedonatelli.github.io/sidecar](https://nedonatelli.github.io/sidecar/)

- **[docs/backends.md](docs/backends.md)** — setup, tuning, and limits for every backend
- **[docs/model-compatibility.md](docs/model-compatibility.md)** — which local models work for agent mode, hardware guidance, and which to avoid
- **[SECURITY.md](SECURITY.md)** — threat model, secret-pattern catalog, vulnerability disclosure
- **[docs/extending-sidecar.md](docs/extending-sidecar.md)** — skills, custom tools, MCP servers, policy hooks
- **[CHANGELOG.md](CHANGELOG.md)** — per-release notes
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — building, testing, and contributing
- Architecture diagrams: [agent loop](docs/agent-loop-diagram.md) · [tool dispatch](docs/tool-system-diagram.md) · [context pipeline](docs/context-pipeline-diagram.md) · [MCP lifecycle](docs/mcp-lifecycle-diagram.md)

## Support

- **Bugs and feature requests:** [GitHub Issues](https://github.com/nedonatelli/sidecar/issues)
- **Security issues:** private disclosure via [SECURITY.md](SECURITY.md); please don't open public issues for vulnerabilities
- **Email:** [sidecarai.vscode@gmail.com](mailto:sidecarai.vscode@gmail.com)

SideCar is free and always will be. If it saves you time, a tip is appreciated but never required:

<a href="https://www.buymeacoffee.com/nedonatelli" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-red.png" alt="Buy Me A Coffee" width="160" height="40"></a>

## Disclaimer

SideCar is an independent project by Nicholas Donatelli and is not affiliated with, endorsed by, or sponsored by Ollama, Anthropic, Meta, Mistral AI, Google, GitHub, or any other company. All product names are trademarks of their respective holders.

## License

[MIT](LICENSE)
