---
title: Model Recommendations
layout: docs
nav_order: 2
nav_section: 'Get Started'
---

# Model Recommendations

SideCar works with local Ollama models, Kickstand, Anthropic, OpenAI, OpenRouter, Groq, and Fireworks. This page helps you pick the right model for your hardware and use case. Numbers come from the [Model Eval Results](model-eval-results.md) page, which documents scores from the deterministic eval harness (92 cases: 57 agent + 35 prompt).

---

## Quick Picks

| Use case                        | Recommended model                                          | Why                                                                                                                                                                                                     |
| ------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Best all-around local (default) | `gemma4:e4b`                                               | The most-dogfooded local model — its agent quirks are the best understood and hardened against; strongest prompt-following (94%), 80% overall eval; cold-start handled automatically; 9 GB, ~10 GB VRAM |
| Highest agent score (local)     | `ministral-3:latest`                                       | 98% agent / 84% overall eval — the lighter pick (6 GB, 8 GB VRAM) when VRAM is tight or pure tool-use reliability matters most                                                                          |
| Low-RAM local                   | `granite4.1:3b`                                            | 81% eval; 2 GB — the lightweight alternative when 8 GB VRAM isn't available                                                                                                                             |
| Best cloud                      | `claude-haiku-4-5-20251001`                                | 96% overall (88/92); highest score of all tested models; fast, cheap, 200K context                                                                                                                      |
| Best budget cloud               | `claude-haiku-4-5-20251001`                                | Significantly cheaper than Sonnet/Opus at near-identical scores for agentic tasks; SideCar prompt caching cuts input costs ~90% on cache hits                                                           |
| Best for large codebases        | `claude-haiku-4-5-20251001` or `deepseek-v4-pro`           | 200K context (Haiku) or 1M context (DeepSeek v4 Pro via Fireworks) — both handle full-repo indexing without truncation                                                                                  |
| Best for speed                  | `gemma4:2b` (local) or `claude-haiku-4-5-20251001` (cloud) | Smallest local model that still supports tool use; Haiku has the lowest latency of the Claude family                                                                                                    |

---

## Local Models

SideCar's local context cap is **32,768 tokens** (`LOCAL_CONTEXT_CAP`). Very large prompts cause extreme first-token latency on consumer hardware regardless of a model's native context window, so this cap applies to all Ollama and Kickstand requests.

| Model                   | Size    | Min VRAM | Tool Use | Context              | Best For                                                                                                                                         |
| ----------------------- | ------- | -------- | -------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gemma4:e4b`            | 9 GB    | 10 GB    | Native   | 128K (capped at 32K) | **Default SideCar model**; most-dogfooded local model; strongest prompt-following (94%), 80% overall; needs a cold-start (handled automatically) |
| `ministral-3:latest`    | 6 GB    | 8 GB     | Native   | 128K (capped at 32K) | Highest agent eval (98%) of local models; the lighter alternative to the default when VRAM is tight                                              |
| `granite4.1:3b`         | 2 GB    | 4 GB     | Native   | 128K (capped at 32K) | Low-RAM alternative to the default; 81% eval                                                                                                     |
| `gemma4:2b`             | ~3 GB   | 4 GB     | Native   | 128K (capped at 32K) | Low-RAM machines; fast turnaround; good for simple edits and Q&A                                                                                 |
| `qwen3-coder:30b`       | ~18 GB  | 20 GB    | Native   | 32K                  | Highest code quality among local models; speculative decoding supported (draft: `qwen2.5-coder:0.5b`)                                            |
| `qwen3-coder:8b`        | ~5 GB   | 6 GB     | Native   | 32K                  | Solid mid-range coding model; speculative decoding supported                                                                                     |
| `qwen2.5-coder:7b`      | ~4.5 GB | 5 GB     | Native   | 32K                  | Reliable tool use; speculative decoding supported; good for focused coding tasks                                                                 |
| `llama3.1:8b`           | ~5 GB   | 6 GB     | Native   | 128K (capped at 32K) | General-purpose; broad instruction following; widely tested with Ollama                                                                          |
| `llama3.3:70b`          | ~40 GB  | 48 GB    | Native   | 128K (capped at 32K) | Maximum local quality; requires high-end hardware; not recommended on unified-memory Macs under 48 GB                                            |
| `deepseek-coder-v2:16b` | ~9 GB   | 10 GB    | Native   | 128K (capped at 32K) | Strong on code completion and multi-file edits; speculative decoding supported (draft: `deepseek-coder:1.3b-base`)                               |
| `phi-4:14b`             | ~8 GB   | 9 GB     | Native   | 16K                  | Microsoft reasoning model; good for logic-heavy refactoring; modest context window                                                               |
| `codestral:22b`         | ~12 GB  | 14 GB    | Native   | 32K                  | Mistral's code-first model; strong fill-in-the-middle for inline completions                                                                     |

> **RAM ceiling on 36 GB hardware:** models larger than ~12 GB risk OOM when another model is already loaded. Always unload the active model before pulling a large one. `qwen3.6` (23 GB) caused a kernel panic in testing — it is excluded from this list.

---

## Cloud Models

Cloud models are accessed via their respective APIs. SideCar stores API keys in VS Code's SecretStorage per-provider — switching backends doesn't overwrite keys. Use `SideCar: Switch Backend` or the gear button in the chat header to change providers.

| Model                       | Provider  | Context | Best For                                                                                                             | Approx cost / 1M tokens (input / output) |
| --------------------------- | --------- | ------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `claude-sonnet-4-6`         | Anthropic | 200K    | Complex multi-step agent tasks; large codebase refactors; highest reasoning depth in the Sonnet tier                 | ~$3 / $15                                |
| `claude-haiku-4-5-20251001` | Anthropic | 200K    | Daily driver; 96% eval score at a fraction of Sonnet cost; fastest Claude model                                      | ~$0.80 / $4                              |
| `claude-opus-4-7`           | Anthropic | 200K    | Maximum quality for the hardest architectural tasks; significantly more expensive                                    | ~$15 / $75                               |
| `gpt-4o`                    | OpenAI    | 128K    | General-purpose; strong reasoning; requires a paid OpenAI tier (free tier exhausted after 1–2 requests)              | ~$2.50 / $10                             |
| `gpt-4o-mini`               | OpenAI    | 128K    | Budget OpenAI option; reliable tool use; the 200K TPM org-level ceiling can cause rate-limit failures on heavy usage | ~$0.15 / $0.60                           |

> **Anthropic prompt caching:** SideCar automatically enables prompt caching for the Anthropic backend. Cache hits reduce input token costs by ~90%. On a typical agent session the system prompt and tool schemas are cached after the first turn, so most of the per-turn cost is output tokens only.

> **OpenAI rate limits:** SideCar's system prompt + tool schemas total ~23K tokens per request. The free OpenAI tier (30K TPM) is exhausted after 1–2 requests. The `gpt-4o-mini` / `gpt-4.1-mini` 200K TPM org ceiling can also cause failures during heavy usage. A paid tier with higher TPM limits is required for reliable operation.

---

## Tool Use Compatibility

SideCar's full agentic capabilities — file editing, shell commands, git operations, web search, and all 83 built-in tools — require function calling (tool use). Models without it fall back to chat-only mode automatically.

### Reliable tool use (native function calling)

These models pass tool-use cases consistently in the eval harness:

- All current Claude models (`claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-7`)
- `gemma4:e4b`, `gemma4:2b`
- `qwen3-coder:30b`, `qwen3-coder:8b`, `qwen2.5-coder:7b`
- `llama3.1:8b`, `llama3.3:70b`
- `deepseek-coder-v2:16b`
- `phi-4:14b`
- `codestral:22b`
- `deepseek-v4-pro` (Fireworks)
- `gpt-4o`, `gpt-4o-mini` (OpenAI, paid tier)

### Text-based tool call fallback (qwen3 / Hermes style)

Some models emit tool calls as structured text inside the model's response rather than via the API's native function-calling mechanism. SideCar's `textParsing.ts` module parses these automatically, so models like `qwen3.5` and Hermes-format models work with the full tool suite. Performance is slightly less reliable than native function calling — expect occasional parse failures on complex multi-tool turns.

Models in this category: `qwen3.5:latest` and any Hermes-format model. Check the [eval results](model-eval-results.md) page for per-case failure rates before relying on these for production agent workflows.

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

These estimates apply to Q4_K_M quantization (the default Ollama pull format). Actual VRAM usage varies by quant level, batch size, and context in use. The figures below assume a 32K context window (SideCar's `LOCAL_CONTEXT_CAP`).

| Model size | Min VRAM (Q4_K_M, 32K ctx) | Recommended VRAM |
| ---------- | -------------------------- | ---------------- |
| 3B         | 3 GB                       | 4 GB             |
| 7B         | 5 GB                       | 6 GB             |
| 8B         | 5.5 GB                     | 8 GB             |
| 14B        | 9 GB                       | 12 GB            |
| 30B        | 18 GB                      | 24 GB            |
| 70B        | 40 GB                      | 48 GB            |

> **Unified memory (Apple Silicon):** VRAM and system RAM share the same pool. A 36 GB M3 Max or M4 Pro can comfortably run models up to 14B. For 30B models, close other GPU-heavy applications first. 70B models require at least a 64 GB configuration.

> **Multi-GPU:** Ollama and Kickstand both support splitting large models across multiple GPUs. Set `OLLAMA_NUM_GPU_LAYERS` or use Kickstand's layer-assignment config if you need to run a 30B+ model on a multi-GPU workstation.

---

## The Architect / Editor Split

SideCar supports a two-model workflow where a larger, slower model does planning and a smaller, faster model executes edits. Configure this with `sidecar.editorModel` in your workspace or user settings.

```json
{
  "sidecar.model": "claude-sonnet-4-6",
  "sidecar.editorModel": "claude-haiku-4-5-20251001"
}
```

In this setup, `sidecar.model` handles intent classification, plan generation, and reasoning-heavy turns. `sidecar.editorModel` handles `edit_file`, `write_file`, and other execution turns where speed matters more than reasoning depth. The agent loop routes tool-execution turns to the editor model automatically.

### Example configs

**Local: quality planning + fast execution**

```json
{
  "sidecar.model": "qwen3-coder:30b",
  "sidecar.editorModel": "qwen3-coder:8b"
}
```

**Hybrid: cloud planning + local execution (minimize API spend)**

```json
{
  "sidecar.model": "claude-haiku-4-5-20251001",
  "sidecar.editorModel": "qwen2.5-coder:7b"
}
```

**Cloud: premium planning + budget execution**

```json
{
  "sidecar.model": "claude-sonnet-4-6",
  "sidecar.editorModel": "claude-haiku-4-5-20251001"
}
```

> When `sidecar.editorModel` is not set, the main model handles all turns. The split is optional — most users run a single model.

---

## What to Avoid

| Model                                              | Problem                                                                                                          |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `laguna-xs.2`                                      | Freezes when tool schemas are present — hard incompatibility, not recoverable                                    |
| `glm-4.7-flash`                                    | >300s prefill on 36 GB hardware; effectively unusable as an agent                                                |
| `qwen3.6`                                          | Causes kernel panic (OOM) on 36 GB unified-memory hardware when loaded alongside any other model                 |
| `llama-v3p3-70b-instruct` (Fireworks)              | Exceeds its own 131K context limit when SideCar's tool schemas are included; only works for chat (no agent)      |
| `meta-llama/llama-4-maverick` (OpenRouter)         | OpenRouter routing has no tool-use endpoint for this model; every agent case 404s                                |
| `gpt-4o` / `gpt-4o-mini` on free OpenAI tier       | 30K–200K TPM exhausted after 1–8 requests at SideCar's token footprint                                           |
| `llama-4-scout-17b-16e-instruct` on free Groq tier | 30K TPM exhausted after 1 request; requires a paid Groq account                                                  |
| `llama-3.3-70b-versatile` on free Groq tier        | 12K TPM is smaller than a single SideCar request; completely unusable                                            |
| Any model under 3B parameters                      | Too small to reliably follow SideCar's system prompt rules and tool schemas; high failure rates on agentic tasks |

### Common failure patterns across all models

Even well-performing models have consistent weak spots. Be aware of these when reviewing agent output:

- **Verbosity on simple questions** (`rule3-concise-prose`): all tested models occasionally write paragraphs for one-sentence questions. If this is a recurring issue, add a conciseness reminder to your SIDECAR.md.
- **Error-recovery hesitation**: models sometimes find the right file but ask "would you like me to read it?" instead of reading it directly. SideCar's Rule 5 was strengthened in v0.87 to reduce this.
- **Ambiguous rename targets**: when two functions have similar names, models tend to guess and then hedge. If a rename goes to the wrong target, undo and re-state the target function name explicitly.
- **Regex search avoidance**: some models read files one by one instead of using `grep` with a pattern. The agent loop's cycle detection catches runaway file-reading loops, but you may need to steer the model toward `search_files` on large codebases.
