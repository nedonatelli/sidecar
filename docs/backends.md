---
title: Backends
layout: docs
nav_order: 3
nav_section: 'Get Started'
---

# Backends

SideCar routes all LLM communication through a unified `ApiBackend` interface. You can switch backends at any time via the **☰ menu → Backend** in the chat header or `SideCar: Switch Backend` from the Command Palette — the profile switcher sets `baseUrl`, `provider`, and `model` in one click and keeps each backend's API key in its own SecretStorage slot.

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

| Setting            | Value                              |
| ------------------ | ---------------------------------- |
| `sidecar.baseUrl`  | `http://localhost:11434` (default) |
| `sidecar.provider` | `ollama` (auto-detected)           |
| `sidecar.model`    | any model name from `ollama list`  |

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

On the Ollama backend, SideCar probes each model for tool/function-calling support via `/api/show` and caches the result. Models known not to support tools fall into chat-only mode automatically — SideCar won't send tool definitions to them and won't attempt to parse tool calls from their output.

At runtime, if an Ollama model consistently fails to produce valid tool calls after several attempts, SideCar stops sending tool definitions to it for the session (runtime failure tracking per model name).

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
"sidecar.model": "claude-sonnet-5-5"
```

The **☰ menu → Backend → Anthropic Claude** profile sets the base URL and provider for you and selects `claude-haiku-4-5`, the lowest-cost default; set `sidecar.model` to the model you want for agent work.

### Recommended models

| Model               | Use case                                                | Price (input / output per 1M tokens) |
| ------------------- | ------------------------------------------------------- | ------------------------------------ |
| `claude-sonnet-5-5` | Agent work, code generation — best speed/capability mix | $2 / $10                             |
| `claude-opus-5-5`   | Long-running agentic coding and knowledge work          | $4 / $20                             |
| `claude-haiku-5-5`  | Fast, high-volume, budget-friendly completions          | from $0.10 / $0.50                   |
| `claude-fable-5-1`  | Demanding reasoning and long-horizon agentic work       | $10 / $50                            |

`claude-sonnet-5-5` is a good default for agent tasks: strong tool use at a moderate price. Older models (`claude-sonnet-4-6`, `claude-haiku-4-5`, and others) are legacy but still available. Current models and prices: [Anthropic's models overview](https://platform.claude.com/docs/en/about-claude/models/overview).

### Prompt caching

SideCar automatically enables Anthropic's prompt caching by adding `cache_control: { type: "ephemeral" }` breakpoints on the system prompt and on long tool-result blocks. Cache hits reduce input token costs by ~90%. The session spend tracker (`SideCar: Show Session Spend`) reports cache-read tokens separately so you can see the savings.

### Output token ceilings

The backend enforces per-model output token maximums before sending requests — the Anthropic API hard-rejects any `max_tokens` value above the model's ceiling. Ceilings are derived from the prefix table in `anthropicBackend.ts`:

| Model prefix                                           | Max output tokens |
| ------------------------------------------------------ | ----------------- |
| `claude-opus-4`                                        | 32 000            |
| `claude-sonnet-4` / `claude-haiku-4`                   | 64 000            |
| `claude-3-7-sonnet`                                    | 64 000            |
| `claude-3-5-sonnet` / `claude-3-5-haiku`               | 8 192             |
| `claude-3-opus` / `claude-3-sonnet` / `claude-3-haiku` | 4 096             |
| any other model (including the Claude 5 family)        | 64 000            |

The ceiling only caps the request; each response is also limited by `sidecar.maxOutputTokens` (default 32 768).

### Rate limiting

The backend parses `x-ratelimit-*` response headers and tracks remaining request/token budgets. When a rate limit is hit, SideCar waits up to 60 seconds for the reset before surfacing the error to the user. If the wait exceeds 60 s it suggests switching to a fallback backend.

---

## OpenAI

SideCar's `OpenAIBackend` speaks the standard Chat Completions API (`/v1/chat/completions`) with streaming and native tool calling. The same backend class also powers every OpenAI-compatible provider (OpenRouter, Groq, Fireworks, Gemini, LM Studio, vLLM) — this section covers the first-party OpenAI service.

### API key setup

1. Get a key at [platform.openai.com](https://platform.openai.com).
2. Run `SideCar: Set / Refresh API Key` from the Command Palette and paste your key.
3. Keys are stored in VS Code SecretStorage, never in `settings.json`.

### Configuration

```json
"sidecar.baseUrl": "https://api.openai.com",
"sidecar.provider": "openai",
"sidecar.model": "gpt-4o"
```

The **☰ menu → Backend → OpenAI** profile sets all three automatically (default model `gpt-4o`). OpenAI has deprecated `gpt-4o` (shutdown scheduled for 2027-01-14) and `gpt-5` (2026-12-11); pick a current model such as `gpt-6.1-sol` from the model list. See [OpenAI's deprecations page](https://developers.openai.com/api/docs/deprecations).

### Rate-limit note

Every agent request carries SideCar's system prompt and tool definitions — about 11.5K tokens before any conversation — so a tokens-per-minute limit is reached after far fewer requests than with plain chat. OpenAI sets its limits per model, and on the lowest paid tier they are in the millions of tokens per minute, far above that footprint. See [OpenAI's rate-limit guide](https://developers.openai.com/api/docs/guides/rate-limits) for your tier.

---

## OpenRouter

OpenRouter proxies hundreds of models from Anthropic, OpenAI, Google, Meta, Mistral, Cohere, and others through a single OpenAI-compatible endpoint. One API key, one billing relationship, access to 400+ models.

### Configuration

```json
"sidecar.baseUrl": "https://openrouter.ai/api/v1",
"sidecar.provider": "openrouter",
"sidecar.model": "anthropic/claude-sonnet-5.5"
```

The **☰ menu → Backend → OpenRouter** profile sets these for you and selects `anthropic/claude-sonnet-4.5`. Keep `provider` on `openrouter` (or `auto`): with `openai`, requests go through the generic OpenAI backend and skip the OpenRouter cost accounting described below.

Set your OpenRouter API key via `SideCar: Set / Refresh API Key`. Get a key at [openrouter.ai](https://openrouter.ai).

### Model name format

OpenRouter uses fully qualified model IDs in the form `provider/model-name`. Examples:

| Model             | ID                            |
| ----------------- | ----------------------------- |
| Claude Sonnet 5.5 | `anthropic/claude-sonnet-5.5` |
| Claude Sonnet 4.5 | `anthropic/claude-sonnet-4.5` |
| GPT-6.1 Sol       | `openai/gpt-6.1-sol`          |
| Gemini 3.8 Flash  | `google/gemini-3.8-flash`     |

OpenRouter writes version numbers with a dot (`claude-sonnet-5.5`), unlike Anthropic's own API (`claude-sonnet-5-5`). The model picker lists the full live catalog.

### Free tier

OpenRouter offers free access to selected models, marked with a `:free` suffix on the model ID. These are rate-limited but useful for evaluation; which models are free changes over time, so check the catalog.

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
"sidecar.provider": "groq",
"sidecar.model": "openai/gpt-oss-120b"
```

Set your Groq API key via `SideCar: Set / Refresh API Key`. Get a key at [console.groq.com](https://console.groq.com).

> **Warning — the free tier does not work with SideCar.** Groq's free (`on_demand`) tier caps every model at 8,000 tokens per minute. A single SideCar agent request (system prompt + tool schemas) is ~11,500 tokens, so Groq rejects it with `413 Request too large … tokens per minute (TPM): Limit 8000` before the model runs. Only tool-free requests (plan mode) fit. Use Groq only with a paid Dev Tier account; otherwise pick another backend.

### Available models

| Model                 | Context | Notes                          |
| --------------------- | ------- | ------------------------------ |
| `openai/gpt-oss-120b` | 128 k   | Default; strongest tool use    |
| `openai/gpt-oss-20b`  | 128 k   | Fastest, lowest latency        |
| `qwen/qwen3.8-27b`    | 128 k   | Preview tier; may be withdrawn |

### Speed vs. context trade-off

Groq's speed advantage is most pronounced on smaller models. `gpt-oss-20b` can return full agent turns in under a second. Larger models (70B+) are still faster than GPU inference but the gap narrows. Context limits are competitive (128 k on most models) but some Groq-hosted variants have tighter ceilings than the same model on other providers — check the Groq console for current limits.

Groq's wire protocol is byte-identical to OpenAI's `/v1/chat/completions` — same request shape, same SSE framing, same `tool_calls` delta format, same `stream_options.include_usage` support.

---

## Fireworks AI

Fireworks hosts open-weight models (DeepSeek V3, Qwen 2.5 Coder, Llama 3.3, Mixtral, and others) at competitive pricing via an OpenAI-compatible endpoint.

### Configuration

```json
"sidecar.baseUrl": "https://api.fireworks.ai/inference/v1",
"sidecar.provider": "fireworks",
"sidecar.model": "accounts/fireworks/models/qwen2p5-coder-32b-instruct"
```

Set your Fireworks API key via `SideCar: Set / Refresh API Key`. Get a key at [fireworks.ai](https://fireworks.ai).

### Model name format

Fireworks uses fully qualified IDs with the `accounts/fireworks/models/` prefix:

| Model              | ID                                                     |
| ------------------ | ------------------------------------------------------ |
| DeepSeek V3 (0324) | `accounts/fireworks/models/deepseek-v3-0324`           |
| Qwen2.5 Coder 32B  | `accounts/fireworks/models/qwen2p5-coder-32b-instruct` |
| Llama 3.3 70B      | `accounts/fireworks/models/llama-v3p3-70b-instruct`    |
| Mixtral 8x22B      | `accounts/fireworks/models/mixtral-8x22b-instruct`     |
| DeepSeek R1        | `accounts/fireworks/models/deepseek-r1`                |

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

|                          | LM Studio              | Ollama                 |
| ------------------------ | ---------------------- | ---------------------- |
| Model management         | GUI                    | CLI (`ollama pull`)    |
| Auto-launch from SideCar | No                     | Yes                    |
| FIM / inline completions | Yes                    | Yes                    |
| Modelfile customization  | No                     | Yes                    |
| API surface              | OpenAI-compat only     | Native + OpenAI-compat |
| Context window config    | Per-model slider in UI | Modelfile `num_ctx`    |

If you only need a CLI workflow, Ollama is simpler. If you prefer a GUI for organizing and loading models, LM Studio works equally well as a backend.

---

## vLLM

vLLM is a high-throughput inference server designed for multi-user serving and large-batch workloads. It exposes an OpenAI-compatible endpoint and supports tensor parallelism across multiple GPUs.

### Configuration

Choose **Custom endpoint** in the backend menu (chat settings → Backend, or `SideCar: Switch Backend`), enter the server URL (e.g. `http://localhost:8000/v1`), then the API key you passed to `vllm serve --api-key` — or leave it empty if you didn't set one. SideCar lists the served models and selects one.

The equivalent settings, if you prefer to edit them by hand:

```json
"sidecar.baseUrl": "http://localhost:8000",
"sidecar.provider": "openai-compat",
"sidecar.model": "Qwen/Qwen2.5-Coder-32B-Instruct"
```

The model name must match the HuggingFace repo ID used at launch (or the `--served-model-name` flag if you set one).

SideCar reads the model's context window from the server (`max_model_len` on `/v1/models`), so history is compressed before a request can exceed `--max-model-len`. When the server is on this machine (`localhost`), SideCar also applies the prompt-size and tool-catalog limits it uses for local Ollama models; a vLLM server elsewhere on the network is treated like a cloud API.

### Launch example

```bash
vllm serve Qwen/Qwen2.5-Coder-32B-Instruct \
  --max-model-len 32768 \
  --gpu-memory-utilization 0.9 \
  --enable-auto-tool-choice \
  --tool-call-parser hermes
```

The last two flags turn on tool calling, which SideCar's agent needs to edit files and run commands. The parser depends on the model family (`hermes` for Qwen 2.5; see vLLM's tool-calling docs for others).

### vLLM vs. Ollama

|                          | vLLM                                 | Ollama                |
| ------------------------ | ------------------------------------ | --------------------- |
| Target use case          | Multi-user serving, batch throughput | Single-user local dev |
| Model format             | HuggingFace safetensors              | GGUF (quantized)      |
| GPU requirement          | CUDA (NVIDIA), ROCm (AMD)            | CUDA, Metal, CPU      |
| Context parallelism      | Yes (PagedAttention)                 | No                    |
| Auto-launch from SideCar | No                                   | Yes                   |

Use vLLM when you want to run a full-precision or lightly quantized model with maximum throughput, or when sharing an inference server across multiple users. Use Ollama for personal local dev where ease of setup matters more than throughput.

---

## AWS Bedrock

Run Claude models through AWS Bedrock. Bedrock accepts the native Anthropic Messages format, so tool use, thinking, and streaming all work the same as the direct Anthropic backend — the difference is auth (AWS SigV4) and that the model lives in the URL.

### Credentials

No API key prompt. SideCar uses the standard AWS credential chain, in order:

1. Environment: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` (for temporary creds).
2. The shared credentials file `~/.aws/credentials` for the active profile (`AWS_PROFILE`, default `default`).

> SSO / role-assumption / IMDS are not resolved natively — export static keys (e.g. via `aws sso login` + `aws configure export-credentials`, or your own tooling) into the environment.

### Configuration

```json
"sidecar.provider": "bedrock",
"sidecar.bedrock.region": "us-east-1",
"sidecar.model": "us.anthropic.claude-sonnet-4-20250514-v1:0"
```

The Bedrock Runtime endpoint is derived as `bedrock-runtime.<region>.amazonaws.com`. Switching to the **AWS Bedrock** profile from the ☰ menu in chat sets `provider` + a default model and then prompts you to pick the region — or run **SideCar: Bedrock: Set Region** any time. So the whole setup (provider, model, key, region) is doable without editing `settings.json`.

**AWS GovCloud** is supported: choose `us-gov-west-1` / `us-gov-east-1` in the region picker (or type any region in the custom entry). The endpoint resolves to `bedrock-runtime.us-gov-west-1.amazonaws.com`, and SigV4/bearer auth and the Anthropic payload are identical to commercial regions — just make sure your Bedrock model access and credentials are in the GovCloud partition.

### Auth

No API key prompt for IAM, but Bedrock also supports a single **Bedrock API key** (bearer token). SideCar uses, in order: a stored key (`SideCar: Set / Refresh API Key`) or `AWS_BEARER_TOKEN_BEDROCK` → `Authorization: Bearer`; otherwise SigV4 with IAM credentials.

### Models

The model dropdown is populated **live** by querying the Bedrock control plane (`ListInferenceProfiles` + `ListFoundationModels` on `bedrock.<region>.amazonaws.com`), filtered to Anthropic/Claude models — both cross-region inference profiles (`us.anthropic.…`, required for newer Claude) and on-demand foundation models. If the query is denied (e.g. a Bedrock API key scoped only to `InvokeModel`, or missing `bedrock:ListFoundationModels` permission), it falls back to a static list; you can always type any model / inference-profile id directly, e.g.:

| Model                                  | ID                                           |
| -------------------------------------- | -------------------------------------------- |
| Claude Sonnet 4 (cross-region profile) | `us.anthropic.claude-sonnet-4-20250514-v1:0` |
| Claude 3.5 Sonnet v2                   | `anthropic.claude-3-5-sonnet-20241022-v2:0`  |
| Claude 3.5 Haiku                       | `anthropic.claude-3-5-haiku-20241022-v1:0`   |

Make sure the model is **enabled in your Bedrock account** for the chosen region (Bedrock console → Model access), or requests return an access error. Only Anthropic/Claude models are listed, since the backend speaks the Anthropic payload.

> Prompt caching (`cache_control`) is not sent on the Bedrock path yet — Bedrock gates it per-account — so you won't see the ~90% cache discount that the direct Anthropic backend gives.

---

## Google Gemini

SideCar uses Google's OpenAI-compatible endpoint at `generativelanguage.googleapis.com`. The standard OpenAI SSE stream parser handles all Gemini responses — no special protocol handling is required.

### API key setup

1. Get a key at [aistudio.google.com](https://aistudio.google.com) (free tier available).
2. Run `SideCar: Set / Refresh API Key` and paste your key.

### Configuration

```json
"sidecar.baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
"sidecar.provider": "gemini",
"sidecar.model": "gemini-3.8-flash"
```

Note the base URL ends at `/openai` — do not append `/v1`. SideCar's `GeminiBackend` constructs the full endpoint as `${baseUrl}/chat/completions` (not `${baseUrl}/v1/chat/completions`).

### Available models

SideCar fetches the live model list from the Gemini API using your API key. There is no built-in fallback list, so the picker stays empty until a key is set.

Google recommends `gemini-3.8-flash` for new projects (or `gemini-3.5-flash-lite` for lower cost). The 2.5 models (`gemini-2.5-flash`, `gemini-2.5-pro`) are served only to accounts that already used them, and `gemini-2.0-flash` has been shut down. See [Google's model list](https://ai.google.dev/gemini-api/docs/models).

> The **☰ menu → Backend → Google Gemini** profile still selects `gemini-2.0-flash`, which Google has shut down. After switching, pick a current model from the model list.

---

## GitHub Copilot

SideCar can route requests through the VS Code `vscode.lm` Language Model API, which delegates to whatever models GitHub Copilot has made available. This requires an active Copilot subscription and the official GitHub Copilot extension installed.

### Enable

```json
"sidecar.provider": "copilot",
"sidecar.model": "gpt-4o"
```

With `sidecar.provider` set to `copilot` (or **GitHub Copilot** picked in the backend menu), SideCar routes requests through `vscode.lm.selectChatModels`. It matches `sidecar.model` against a Copilot model's id, then its family; if neither matches, it uses the first model Copilot offers. The Copilot extension handles authentication, token management, and rate limiting — SideCar never sees or stores a Copilot token.

### How it works

SideCar's `CopilotBackend` converts its internal `ChatMessage` format to `vscode.LanguageModelChatMessage` objects and calls the VS Code Language Model API. System prompts are prepended as a user message with a `[System Instructions]` prefix (the `vscode.lm` API has no native system-role concept).

**Limitations:**

- Image and thinking content blocks are silently dropped — the `vscode.lm` API has no equivalent types.
- Agent mode needs a Copilot model that supports tool calling through the `vscode.lm` tool-use API. SideCar always sends its tool definitions and does not retry without them, so a model without tool support fails agent requests instead of falling back to chat-only.
- Rate limiting and quota management are controlled by the Copilot extension. If you hit Copilot limits, SideCar surfaces the VS Code error directly without additional wrapping.
- `SideCar: Show Session Spend` shows $0.00 for Copilot — spend is billed through your Copilot subscription, not tracked per-token by SideCar.

### Prerequisites

- GitHub Copilot extension installed and signed in
- An active GitHub Copilot plan
- VS Code 1.116.0 or later (SideCar's minimum version)
