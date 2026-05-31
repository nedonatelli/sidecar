---
title: Backends
layout: docs
nav_order: 3
nav_section: "Get Started"
---

# Backends

SideCar routes all LLM communication through a unified `ApiBackend` interface. You can switch backends at any time via the **⚙ gear** in the chat header or `SideCar: Switch Backend` from the Command Palette — the profile switcher sets `baseUrl`, `provider`, and `model` in one click and keeps each backend's API key in its own SecretStorage slot.

For custom setups (non-standard ports, proxies, dev builds), edit `settings.json` directly.

**Circuit breaker:** every backend has a per-provider circuit breaker. After 5 consecutive failures it trips open and fast-fails new requests. After a cooldown period (15 s initial, doubling on each trip, capped at 120 s) one probe request is allowed through. If the probe succeeds the breaker closes; if it fails the cooldown resets. This prevents hammering a dead provider while the agent is mid-task.

---

## Ollama (default)

Ollama is the default backend and requires no API key. SideCar auto-launches the Ollama daemon if it is not already running.

### Install

Download from [ollama.com](https://ollama.com) and verify:

```bash
ollama --version
```

Pull models from the Ollama registry:

```bash
# Recommended general-purpose model
ollama pull gemma4:e4b

# Coding-focused, strong tool use
ollama pull qwen3-coder:30b

# Lighter option for machines with less RAM
ollama pull qwen2.5-coder:7b
```

### Connection

| Setting | Value |
|---------|-------|
| `sidecar.baseUrl` | `http://localhost:11434` (default) |
| `sidecar.provider` | `ollama` (auto-detected from port) |
| `sidecar.model` | any model name from `ollama list` |

No API key is needed. The `sidecar.apiKey` setting is ignored for local Ollama.

### Performance tuning

**Context window (`num_ctx`):** Ollama loads models with a default context window of 2048 tokens — far too small for agentic work. Increase it by creating a Modelfile:

```
FROM qwen2.5-coder:7b
PARAMETER num_ctx 32768
```

Then build it: `ollama create qwen2.5-coder-32k -f ./Modelfile`

SideCar probes the effective `num_ctx` via `/api/show` and uses it for context budget calculations. The probed value is cached per model name for the session.

**Keep alive (`keep_alive`):** by default Ollama unloads a model from GPU memory after 5 minutes of inactivity. If you switch models frequently or pause between prompts, you may see cold-start delays. Set a longer keep-alive in your Modelfile:

```
PARAMETER keep_alive 30m
```

Or set it globally via Ollama's environment variable: `OLLAMA_KEEP_ALIVE=30m`.

### Tool support

SideCar probes each model for tool/function-calling support via `/api/show` and caches the result. Models known not to support tools fall into chat-only mode automatically — SideCar won't send tool definitions to them and won't attempt to parse tool calls from their output.

At runtime, if a model consistently fails to produce valid tool calls after several attempts, SideCar stops sending tool definitions to it for the session (runtime failure tracking per model name).

### Troubleshooting

**"Cannot connect to Ollama"** — verify the daemon is running: `ollama serve`. SideCar will attempt to launch it automatically but falls back gracefully if it can't.

**Port conflict** — if you've configured Ollama on a non-standard port, set `sidecar.baseUrl` to match:

```json
"sidecar.baseUrl": "http://localhost:12345"
```

**PATH issue on macOS** — if SideCar can't auto-launch Ollama, ensure `/usr/local/bin` or wherever `ollama` is installed is on your shell's PATH. The extension spawns processes using a login shell but PATH inheritance varies by installation method.

---

## Anthropic Claude

SideCar has a dedicated `AnthropicBackend` that uses the native Messages API (`/v1/messages`) rather than the OpenAI-compat shim. This enables prompt caching, extended thinking, and accurate per-model output token ceilings.

### API key setup

1. Get a key at [platform.claude.com](https://platform.claude.com).
2. Run `SideCar: Set / Refresh API Key` from the Command Palette and paste your key.
3. Keys are stored in VS Code SecretStorage (macOS Keychain / Windows Credential Manager / libsecret), never in `settings.json`.

> Anthropic API credits are separate from Claude.ai subscriptions. A Max or Pro plan does not include API credits.

### Configuration

```json
"sidecar.baseUrl": "https://api.anthropic.com",
"sidecar.provider": "anthropic",
"sidecar.model": "claude-sonnet-4-6"
```

The `⚙ gear → Anthropic Claude` profile sets all three automatically.

### Recommended models

| Model | Use case | Max output tokens |
|-------|----------|-------------------|
| `claude-sonnet-4-6` | Agent work, code generation, complex reasoning | 64 000 |
| `claude-haiku-4-5` | Fast, budget-friendly completions | 64 000 |
| `claude-opus-4` | Maximum capability, highest cost | 32 000 |
| `claude-3-5-sonnet-20241022` | Strong coding, previous generation | 8 192 |

`claude-sonnet-4-6` is the recommended default for agent tasks — it has the highest output ceiling (64 k tokens), strong tool use, and a good cost/capability ratio.

### Prompt caching

SideCar automatically enables Anthropic's prompt caching by adding `cache_control: { type: "ephemeral" }` breakpoints on the system prompt and on long tool-result blocks. Cache hits reduce input token costs by ~90%. The session spend tracker (`SideCar: Show Session Spend`) reports cache-read tokens separately so you can see the savings.

### Output token ceilings

The backend enforces per-model output token maximums before sending requests — the Anthropic API hard-rejects any `max_tokens` value above the model's ceiling. Ceilings are derived from the prefix table in `anthropicBackend.ts`:

| Model prefix | Max output tokens |
|--------------|-------------------|
| `claude-opus-4` | 32 000 |
| `claude-sonnet-4` / `claude-haiku-4` | 64 000 |
| `claude-3-7-sonnet` | 64 000 |
| `claude-3-5-sonnet` / `claude-3-5-haiku` | 8 192 |
| `claude-3-opus` / `claude-3-sonnet` / `claude-3-haiku` | 4 096 |

### Rate limiting

The backend parses `x-ratelimit-*` response headers and tracks remaining request/token budgets. When a rate limit is hit, SideCar waits up to 60 seconds for the reset before surfacing the error to the user. If the wait exceeds 60 s it suggests switching to a fallback backend.

---

## OpenRouter

OpenRouter proxies hundreds of models from Anthropic, OpenAI, Google, Meta, Mistral, Cohere, and others through a single OpenAI-compatible endpoint. One API key, one billing relationship, access to 400+ models.

### Configuration

```json
"sidecar.baseUrl": "https://openrouter.ai/api/v1",
"sidecar.provider": "openai",
"sidecar.model": "anthropic/claude-sonnet-4-6"
```

Set your OpenRouter API key via `SideCar: Set / Refresh API Key`. Get a key at [openrouter.ai](https://openrouter.ai).

### Model name format

OpenRouter uses fully qualified model IDs in the form `provider/model-name`. Examples:

| Model | ID |
|-------|----|
| Claude Sonnet 4.6 | `anthropic/claude-sonnet-4-6` |
| Claude Haiku 4.5 | `anthropic/claude-haiku-4-5` |
| GPT-4o | `openai/gpt-4o` |
| Gemini 2.0 Flash | `google/gemini-2.0-flash-001` |
| DeepSeek V3 | `deepseek/deepseek-chat-v3-0324` |
| Qwen3 235B | `qwen/qwen3-235b-a22b` |
| Llama 3.3 70B | `meta-llama/llama-3.3-70b-instruct` |

### Free tier

OpenRouter offers free daily credits on selected models (marked with a `:free` suffix). These are rate-limited but useful for evaluation:

```json
"sidecar.model": "meta-llama/llama-3.3-70b-instruct:free"
```

### Cost tracking

SideCar requests OpenRouter's `usage: { include: true }` accounting block, which returns the actual USD cost per request — after OpenRouter's per-account discounts and routed-provider upcharges. The session spend tracker shows accurate costs rather than falling back to a static price table.

SideCar also sends `HTTP-Referer: https://github.com/nedonatelli/sidecar` and `X-Title: SideCar` headers on every request, which appear in the OpenRouter usage leaderboard.

### Model catalog

SideCar fetches the full OpenRouter catalog on startup, including per-model pricing (USD per token), context window, top provider, and free-tier flags. The model picker in the chat panel shows all available models.

---

## Groq

Groq runs LLMs on custom LPU (Language Processing Unit) chips, delivering thousands of tokens per second. The agent loop feels substantially more responsive than GPU inference at the same model size.

### Configuration

```json
"sidecar.baseUrl": "https://api.groq.com/openai/v1",
"sidecar.provider": "openai",
"sidecar.model": "moonshotai/kimi-k2-instruct"
```

Set your Groq API key via `SideCar: Set / Refresh API Key`. Get a key at [console.groq.com](https://console.groq.com).

### Available models

| Model | Context | Notes |
|-------|---------|-------|
| `moonshotai/kimi-k2-instruct` | 128 k | Strong coding and tool use |
| `llama-3.3-70b-versatile` | 128 k | General purpose |
| `llama-3.1-8b-instant` | 128 k | Fastest, lowest latency |
| `mixtral-8x7b-32768` | 32 k | Strong reasoning |
| `gemma2-9b-it` | 8 k | Efficient |

### Speed vs. context trade-off

Groq's speed advantage is most pronounced on smaller models. The 8B Llama instant variant can return full agent turns in under a second. Larger models (70B+) are still faster than GPU inference but the gap narrows. Context limits are competitive (128 k on most models) but some Groq-hosted variants have tighter ceilings than the same model on other providers — check the Groq console for current limits.

Groq's wire protocol is byte-identical to OpenAI's `/v1/chat/completions` — same request shape, same SSE framing, same `tool_calls` delta format, same `stream_options.include_usage` support.

---

## Fireworks AI

Fireworks hosts open-weight models (DeepSeek V3, Qwen 2.5 Coder, Llama 3.3, Mixtral, and others) at competitive pricing via an OpenAI-compatible endpoint.

### Configuration

```json
"sidecar.baseUrl": "https://api.fireworks.ai/inference/v1",
"sidecar.provider": "openai",
"sidecar.model": "accounts/fireworks/models/qwen2p5-coder-32b-instruct"
```

Set your Fireworks API key via `SideCar: Set / Refresh API Key`. Get a key at [fireworks.ai](https://fireworks.ai).

### Model name format

Fireworks uses fully qualified IDs with the `accounts/fireworks/models/` prefix:

| Model | ID |
|-------|----|
| DeepSeek V3 (0324) | `accounts/fireworks/models/deepseek-v3-0324` |
| Qwen2.5 Coder 32B | `accounts/fireworks/models/qwen2p5-coder-32b-instruct` |
| Llama 3.3 70B | `accounts/fireworks/models/llama-v3p3-70b-instruct` |
| Mixtral 8x22B | `accounts/fireworks/models/mixtral-8x22b-instruct` |
| DeepSeek R1 | `accounts/fireworks/models/deepseek-r1` |

### Best models for coding

`qwen2p5-coder-32b-instruct` and `deepseek-v3-0324` are both strong for agentic coding tasks. Fireworks pricing is generally lower than OpenAI for comparable open-weight capability, making it a cost-effective cloud option when you don't want to run models locally.

---

## LM Studio

LM Studio provides a local OpenAI-compatible server (port 1234 by default). It has a graphical model manager and is a good alternative to Ollama if you prefer a GUI for model management.

### Enable the server

In LM Studio: open the **Local Server** tab (left sidebar), load a model, and click **Start Server**. The default port is 1234.

### Configuration

```json
"sidecar.baseUrl": "http://localhost:1234",
"sidecar.provider": "openai",
"sidecar.model": "your-loaded-model-name"
```

No API key is required. The model name must match the identifier LM Studio reports — check the Local Server tab for the exact string.

### LM Studio vs. Ollama

| | LM Studio | Ollama |
|--|-----------|--------|
| Model management | GUI | CLI (`ollama pull`) |
| Auto-launch from SideCar | No | Yes |
| FIM / inline completions | Yes | Yes |
| Modelfile customization | No | Yes |
| API surface | OpenAI-compat only | Native + OpenAI-compat |
| Context window config | Per-model slider in UI | Modelfile `num_ctx` |

If you only need a CLI workflow, Ollama is simpler. If you prefer a GUI for organizing and loading models, LM Studio works equally well as a backend.

---

## vLLM

vLLM is a high-throughput inference server designed for multi-user serving and large-batch workloads. It exposes an OpenAI-compatible endpoint and supports tensor parallelism across multiple GPUs.

### Configuration

```json
"sidecar.baseUrl": "http://localhost:8000",
"sidecar.provider": "openai",
"sidecar.model": "Qwen/Qwen2.5-Coder-32B-Instruct"
```

The model name must match the HuggingFace repo ID used at launch (or the `--served-model-name` flag if you set one).

### Launch example

```bash
vllm serve Qwen/Qwen2.5-Coder-32B-Instruct \
  --max-model-len 32768 \
  --gpu-memory-utilization 0.9
```

### vLLM vs. Ollama

| | vLLM | Ollama |
|--|------|--------|
| Target use case | Multi-user serving, batch throughput | Single-user local dev |
| Model format | HuggingFace safetensors | GGUF (quantized) |
| GPU requirement | CUDA (NVIDIA), ROCm (AMD) | CUDA, Metal, CPU |
| Context parallelism | Yes (PagedAttention) | No |
| Auto-launch from SideCar | No | Yes |

Use vLLM when you want to run a full-precision or lightly quantized model with maximum throughput, or when sharing an inference server across multiple users. Use Ollama for personal local dev where ease of setup matters more than throughput.

---

## Kickstand

Kickstand is a self-hosted local inference server built alongside SideCar. CLI command: `kick`. It focuses on GPU memory efficiency — loading, unloading, and hot-swapping models with minimal overhead.

### Start the server

```bash
kick start
```

Kickstand auto-generates a bearer token at `~/.config/kickstand/token` on first run.

### Configuration

```json
"sidecar.baseUrl": "http://localhost:11435",
"sidecar.provider": "kickstand"
```

**No API key setup required.** SideCar reads `~/.config/kickstand/token` automatically on every request (result cached 60 seconds). You will never see an API key prompt for Kickstand — the `sidecar.apiKey` setting is not used.

The `⚙ gear → Kickstand` profile sets `baseUrl` and `provider` for you.

### Model management

Kickstand exposes model management endpoints that SideCar hooks into directly:

| Operation | Kickstand endpoint |
|-----------|-------------------|
| List registry | `GET /api/v1/models` |
| Pull a model | `POST /api/v1/models/pull` (SSE progress) |
| Load into GPU | `POST /api/v1/models/{id}/load` |
| Unload from GPU | `POST /api/v1/models/{id}/unload` |

These are surfaced in SideCar's model dropdown — you can pull and load models without leaving VS Code.

### Advanced inference features

Kickstand supports capabilities not available in standard Ollama or vLLM setups. Configure these via Kickstand's own settings rather than SideCar:

- **Fill-in-the-Middle (FIM):** optimized code completion using prefix/suffix context — powers SideCar's inline completions on Kickstand.
- **Flash Attention:** enabled by default on supported hardware, reducing memory usage and increasing throughput for long contexts.
- **LoRA adapters:** load fine-tuned LoRA weights on top of a base model at runtime, without restarting the server.
- **Grammar-constrained decoding:** force model output to conform to a JSON schema or EBNF grammar — useful for structured tool-call responses.

---

## Google Gemini

SideCar uses Google's OpenAI-compatible endpoint at `generativelanguage.googleapis.com`. The standard OpenAI SSE stream parser handles all Gemini responses — no special protocol handling is required.

### API key setup

1. Get a key at [aistudio.google.com](https://aistudio.google.com) (free tier available).
2. Run `SideCar: Set / Refresh API Key` and paste your key.

### Configuration

```json
"sidecar.baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
"sidecar.provider": "openai",
"sidecar.model": "gemini-2.0-flash"
```

Note the base URL ends at `/openai` — do not append `/v1`. SideCar's `GeminiBackend` constructs the full endpoint as `${baseUrl}/chat/completions` (not `${baseUrl}/v1/chat/completions`).

### Available models

SideCar fetches the live model list from the Gemini API using your API key. Fallback list when the key is not yet available:

| Model | Notes |
|-------|-------|
| `gemini-2.5-flash-preview-04-17` | Latest Flash, strong reasoning |
| `gemini-2.0-flash` | Fast, multimodal, tool use |
| `gemini-1.5-pro` | Long context (up to 2M tokens) |
| `gemini-1.5-flash` | Faster, lower cost |

`gemini-2.0-flash` is the recommended default — it supports function calling (required for full agentic mode), has a 1M token context window, and is free within Google AI Studio's rate limits.

---

## GitHub Copilot

SideCar can route requests through the VS Code `vscode.lm` Language Model API, which delegates to whatever models GitHub Copilot has made available. This requires an active Copilot subscription and the official GitHub Copilot extension installed.

### Enable

```json
"sidecar.provider": "copilot",
"sidecar.model": "copilot/gpt-4o"
```

SideCar auto-detects the `copilot` provider and routes requests through `vscode.lm.selectChatModels`. The Copilot extension handles authentication, token management, and rate limiting — SideCar never sees or stores a Copilot token.

### How it works

SideCar's `CopilotBackend` converts its internal `ChatMessage` format to `vscode.LanguageModelChatMessage` objects and calls the VS Code Language Model API. System prompts are prepended as a user message with a `[System Instructions]` prefix (the `vscode.lm` API has no native system-role concept).

**Limitations:**

- Image and thinking content blocks are silently dropped — the `vscode.lm` API has no equivalent types.
- Tool/function calling depends on whether the selected Copilot model supports it via the `vscode.lm` tool-use API. Not all Copilot-exposed models do; SideCar falls back to chat-only mode if tools are unsupported.
- Rate limiting and quota management are controlled by the Copilot extension. If you hit Copilot limits, SideCar surfaces the VS Code error directly without additional wrapping.
- `SideCar: Show Session Spend` shows $0.00 for Copilot — spend is billed through your Copilot subscription, not tracked per-token by SideCar.

### Prerequisites

- GitHub Copilot extension installed and signed in
- Active Copilot Individual, Business, or Enterprise subscription
- VS Code 1.90 or later (Language Model API stability requirement)
