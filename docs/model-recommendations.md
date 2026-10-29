---
title: Model Recommendations
layout: docs
nav_order: 2
nav_section: 'Get Started'
---

# Model Recommendations

SideCar works with local Ollama models, Anthropic, OpenAI, OpenRouter, Groq, Fireworks, Google Gemini, AWS Bedrock, GitHub Copilot, and any OpenAI-compatible server. This page helps you pick the right model for your hardware and use case. Numbers come from the [Model Eval Results](model-eval-results.md) page: local baselines are from the current 70-case agent suite (2026-08); cloud scores are from the older 92-case suite (2026-05) and are not directly comparable.

---

## Quick Picks

| Use case                        | Recommended model                                     | Why                                                                                                                                                                                                                                |
| ------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Best all-around local (default) | `gemma4:e4b`                                          | The most-dogfooded local model — its agent quirks are the best understood and hardened against; **highest local agent baseline: 96% (67/70, 2026-08)**; cold-start handled automatically; 9.6 GB, ~10 GB VRAM                      |
| Most capable local              | `gemma4:31b`                                          | The most capable local model tested; 20 GB, needs a 32 GB GPU — see [Model Compatibility](model-compatibility.md#running-gemma4-31b-on-a-32-gb-gpu) for the memory caveat                                                          |
| Lighter local pick              | `ministral-3:latest`                                  | 89% agent baseline (62/70, 2026-08) — the lighter pick (6 GB, 8 GB VRAM) when VRAM is tight; second-best local agent score                                                                                                         |
| Low-RAM local                   | `granite4.1:3b`                                       | 73% agent baseline (51/70, 2026-08); 2 GB — the lightweight alternative when 8 GB VRAM isn't available                                                                                                                             |
| Best cloud                      | `claude-sonnet-5-5`                                   | Current Claude model with the best speed/capability mix; $2 / $10 per 1M tokens, 1M context. The top eval score on record (96%, 88/92) is the now-legacy `claude-haiku-4-5`; Claude 5 models have not been run through the harness |
| Best budget cloud               | `claude-haiku-5-5`                                    | Cheapest current Claude model (from $0.10 / $0.50 per 1M tokens); SideCar prompt caching cuts input costs further on cache hits                                                                                                    |
| Best for large codebases        | `claude-sonnet-5-5` or `glm-5p3`                      | 1M context (current Claude models) or 1M context (GLM 5.3 via Fireworks) — both handle full-repo indexing without truncation                                                                                                       |
| Best for speed                  | `granite4.1:3b` (local) or `claude-haiku-5-5` (cloud) | Smallest local model that still supports tool use; Haiku has the lowest latency of the Claude family                                                                                                                               |

---

## Local Models

SideCar clamps local context windows to **131,072 tokens** (`LOCAL_CONTEXT_CAP`, matching gemma4:e4b's native 128K), with per-model caps that override downward where a model's KV cache would OOM the machine (e.g. llama3.2 is capped at 64K). Set `sidecar.ollama.numCtx` explicitly (e.g. 32768) on low-VRAM machines — a large KV cache costs real first-token latency.

| Model                   | Size    | Min VRAM | Tool Use | Context                | Best For                                                                                                                                                             |
| ----------------------- | ------- | -------- | -------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gemma4:e4b`            | 9.6 GB  | 10 GB    | Native   | 128K (SideCar-clamped) | **Default SideCar model**; most-dogfooded local model; highest local agent baseline (96%, 2026-08); needs a cold-start (handled automatically)                       |
| `gemma4:31b`            | 20 GB   | 32 GB    | Native   | 128K (SideCar-clamped) | Most capable local model tested; at 131K context it only just fits a 32 GB GPU (see [Model Compatibility](model-compatibility.md#running-gemma4-31b-on-a-32-gb-gpu)) |
| `ministral-3:latest`    | 6 GB    | 8 GB     | Native   | 128K (SideCar-clamped) | Second-best local agent baseline (89%, 2026-08); the lighter alternative to the default when VRAM is tight                                                           |
| `granite4.1:3b`         | 2 GB    | 4 GB     | Native   | 128K (SideCar-clamped) | Low-RAM alternative to the default; 73% agent baseline (2026-08)                                                                                                     |
| `qwen3-coder:30b`       | ~18 GB  | 20 GB    | Native   | 32K                    | Highest code quality among local models; speculative decoding supported (draft: `qwen2.5-coder:0.5b`)                                                                |
| `qwen2.5-coder:7b`      | ~4.5 GB | 5 GB     | Text     | 32K                    | Emits tool calls as bare JSON text, not native calls — SideCar's text parser handles them; speculative decoding supported                                            |
| `llama3.1:8b`           | ~5 GB   | 6 GB     | Native   | 128K (SideCar-clamped) | General-purpose; broad instruction following; widely tested with Ollama                                                                                              |
| `llama3.3:70b`          | ~40 GB  | 48 GB    | Native   | 128K (SideCar-clamped) | Maximum local quality; requires high-end hardware; not recommended on unified-memory Macs under 48 GB                                                                |
| `deepseek-coder-v2:16b` | ~9 GB   | 10 GB    | Native   | 128K (SideCar-clamped) | Strong on code completion and multi-file edits; speculative decoding supported (draft: `deepseek-coder:1.3b-base`)                                                   |
| `phi4:14b`              | ~8 GB   | 9 GB     | Native   | 16K                    | Microsoft reasoning model; good for logic-heavy refactoring; modest context window                                                                                   |
| `codestral:22b`         | ~12 GB  | 14 GB    | Native   | 32K                    | Mistral's code-first model; strong fill-in-the-middle for inline completions                                                                                         |

> **RAM ceiling on 36 GB hardware:** models larger than ~12 GB risk OOM when another model is already loaded. Always unload the active model before pulling a large one. `qwen3.6` (23 GB) caused a kernel panic in testing — it is excluded from this list.

---

## Cloud Models

Cloud models are accessed via their respective APIs. SideCar stores backend API keys in VS Code's SecretStorage per provider — switching backends doesn't overwrite keys. Use `SideCar: Switch Backend` or the ☰ menu in the chat header to change providers.

| Model               | Provider  | Context | Best For                                                                               | Approx cost / 1M tokens (input / output) |
| ------------------- | --------- | ------- | -------------------------------------------------------------------------------------- | ---------------------------------------- |
| `claude-sonnet-5-5` | Anthropic | 1M      | Complex multi-step agent tasks; large codebase refactors; best speed/capability mix    | $2 / $10                                 |
| `claude-haiku-5-5`  | Anthropic | 1M      | Daily driver for high-volume, latency-sensitive work; fastest Claude model             | from $0.10 / $0.50                       |
| `claude-opus-5-5`   | Anthropic | 1M      | Long-running agentic coding; Anthropic's suggested starting point for most workloads   | $4 / $20                                 |
| `claude-fable-5-1`  | Anthropic | 1M      | Demanding reasoning and long-horizon agentic work; most expensive                      | $10 / $50                                |
| `gpt-6-luna`        | OpenAI    | 922K    | The OpenAI backend-menu default; low-cost tier. `gpt-6-sol` is stronger for agent work | ~$0.10 / $0.50                           |

Earlier Claude models (`claude-sonnet-4-6`, `claude-haiku-4-5`, `claude-opus-4-7`) are legacy but still available; the Anthropic backend-menu entry selects `claude-haiku-5-5`. Prices: [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing).

> **Anthropic prompt caching:** SideCar automatically enables prompt caching for the Anthropic backend. Cache hits reduce input token costs by ~90%. On a typical agent session the system prompt and tool schemas are cached after the first turn, so most of the per-turn cost is output tokens only.

> **Rate limits:** every agent request carries SideCar's system prompt and tool definitions — about 11.5K tokens before any conversation — so a provider's tokens-per-minute limit is reached after far fewer requests than with plain chat. OpenAI sets its limits per model, in the millions of tokens per minute on the lowest paid tier. Groq's free tier (8K TPM) is smaller than one request and does not work.

---

## Tool Use Compatibility

SideCar's full agentic capabilities — file editing, shell commands, git operations, web search, and all 80+ built-in tools — require function calling (tool use). On the Ollama backend, models without it fall back to chat-only mode automatically; other backends always send tool definitions, so pick a tool-capable model there.

### Reliable tool use (native function calling)

These models pass tool-use cases consistently in the eval harness:

- Claude models (`claude-haiku-4-5` was measured in the eval harness; all current Claude models support tool use)
- `gemma4:e4b`
- `qwen3-coder:30b`
- `llama3.1:8b`, `llama3.3:70b`
- `deepseek-coder-v2:16b`
- `phi4:14b`
- `codestral:22b`
- `deepseek-v4-pro` (Fireworks; retired from serverless 2026-09-25)
- `gpt-4o`, `gpt-4o-mini` (OpenAI, paid tier)

### Text-based tool call fallback (qwen3 / Hermes style)

Some models emit tool calls as structured text inside the model's response rather than via the API's native function-calling mechanism. SideCar's `textParsing.ts` module parses these automatically, so models like `qwen3.5` and Hermes-format models work with the full tool suite. Performance is slightly less reliable than native function calling — expect occasional parse failures on complex multi-tool turns.

Models in this category: `qwen3.5:latest`, `qwen2.5-coder:7b`, and any Hermes-format model. Check the [eval results](model-eval-results.md) page for per-case failure rates before relying on these for production agent workflows.

### No tool use / incompatible

| Model                                      | Issue                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `meta-llama/llama-4-maverick` (OpenRouter) | No tool-use endpoint; 404 on every agent case                             |
| `laguna-xs.2` (Ollama)                     | Freezes when tool schemas are included in the request                     |
| `glm-4.7-flash` (Ollama)                   | Prefill >300s on 36 GB hardware; unusable                                 |
| `llama-v3p3-70b-instruct` (Fireworks)      | 401 tokens over the 131,072-token limit when tool schemas are included    |
| Most `gemma2` variants                     | Chat-only; no function calling support in Ollama's Gemma 2 implementation |
| Most `llama2` variants                     | Chat-only; no function calling support                                    |

---

## Hardware Requirements

These estimates apply to Q4_K_M quantization (the default Ollama pull format). Actual VRAM usage varies by quant level, batch size, and context in use. The figures below assume a 32K context window. SideCar's own cap (`LOCAL_CONTEXT_CAP`) is 131,072 tokens, and a larger window needs more VRAM — set `sidecar.ollama.numCtx` to 32768 to match these figures.

| Model size | Min VRAM (Q4_K_M, 32K ctx) | Recommended VRAM |
| ---------- | -------------------------- | ---------------- |
| 3B         | 3 GB                       | 4 GB             |
| 7B         | 5 GB                       | 6 GB             |
| 8B         | 5.5 GB                     | 8 GB             |
| 14B        | 9 GB                       | 12 GB            |
| 30B        | 18 GB                      | 24 GB            |
| 70B        | 40 GB                      | 48 GB            |

> **Unified memory (Apple Silicon):** VRAM and system RAM share the same pool. A 36 GB M3 Max or M4 Pro can comfortably run models up to 14B. For 30B models, close other GPU-heavy applications first. 70B models require at least a 64 GB configuration.

> **Multi-GPU:** Ollama supports splitting large models across multiple GPUs. Set `OLLAMA_NUM_GPU_LAYERS` if you need to run a 30B+ model on a multi-GPU workstation.

---

## The Architect / Editor Split

SideCar supports a two-model workflow where a larger, slower model does planning and a smaller, faster model executes edits. Configure this with `sidecar.editorModel` in your workspace or user settings.

```json
{
  "sidecar.model": "claude-sonnet-5-5",
  "sidecar.editorModel": "claude-haiku-5-5"
}
```

In this setup, `sidecar.model` handles intent classification, plan generation, and reasoning-heavy turns. `sidecar.editorModel` handles `edit_file`, `write_file`, and other execution turns where speed matters more than reasoning depth. The agent loop routes tool-execution turns to the editor model automatically.

### Example configs

**Local: quality planning + fast execution**

```json
{
  "sidecar.model": "qwen3-coder:30b",
  "sidecar.editorModel": "qwen2.5-coder:7b"
}
```

**Hybrid: cloud planning + local execution (minimize API spend)**

```json
{
  "sidecar.model": "claude-haiku-5-5",
  "sidecar.editorModel": "qwen2.5-coder:7b"
}
```

**Cloud: premium planning + budget execution**

```json
{
  "sidecar.model": "claude-opus-5-5",
  "sidecar.editorModel": "claude-haiku-5-5"
}
```

> When `sidecar.editorModel` is not set, the main model handles all turns. The split is optional — most users run a single model.

---

## What to Avoid

| Model                                          | Problem                                                                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `laguna-xs.2`                                  | Freezes when tool schemas are present — hard incompatibility, not recoverable                                    |
| `glm-4.7-flash`                                | >300s prefill on 36 GB hardware; effectively unusable as an agent                                                |
| `qwen3.6`                                      | Causes kernel panic (OOM) on 36 GB unified-memory hardware when loaded alongside any other model                 |
| `llama-v3p3-70b-instruct` (Fireworks)          | Exceeds its own 131K context limit when SideCar's tool schemas are included; only works for chat (no agent)      |
| `meta-llama/llama-4-maverick` (OpenRouter)     | OpenRouter routing has no tool-use endpoint for this model; every agent case 404s                                |
| Any provider tier with a TPM limit near ~11.5K | One agent request is ~11.5K tokens; a limit that small fails or exhausts after a request or two                  |
| Any model on the free Groq tier                | 8K TPM is smaller than a single SideCar request (~11.5K); every agent request fails with 413 — Dev Tier required |
| Any model under 3B parameters                  | Too small to reliably follow SideCar's system prompt rules and tool schemas; high failure rates on agentic tasks |

### Common failure patterns across all models

Even well-performing models have consistent weak spots. Be aware of these when reviewing agent output:

- **Verbosity on simple questions** (`rule3-concise-prose`): all tested models occasionally write paragraphs for one-sentence questions. If this is a recurring issue, add a conciseness reminder to your SIDECAR.md.
- **Error-recovery hesitation**: models sometimes find the right file but ask "would you like me to read it?" instead of reading it directly. SideCar's Rule 5 was strengthened in v0.87 to reduce this.
- **Ambiguous rename targets**: when two functions have similar names, models tend to guess and then hedge. If a rename goes to the wrong target, undo and re-state the target function name explicitly.
- **Regex search avoidance**: some models read files one by one instead of using `grep` with a pattern. The agent loop's cycle detection catches runaway file-reading loops, but you may need to steer the model toward `search_files` on large codebases.
