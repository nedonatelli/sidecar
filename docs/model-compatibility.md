---
title: Model Compatibility
layout: docs
nav_order: 4
nav_section: 'Get Started'
---

# Model Compatibility

SideCar works with any model your backend can serve, but agentic coding is demanding: a model must call tools reliably, follow multi-step instructions, and recover from errors. This page lists what we actually measure, so you can pick a model that matches your hardware and expectations.

Ratings come from SideCar's own evaluation suite — an agent-loop smoke suite (read / edit / write / run / plan / error-recovery tasks) plus long-horizon multi-step tasks — re-run against local models as SideCar evolves. Every model in the first table runs the smoke suite with zero infrastructure errors (no crashes, dropped tool calls, or retry thrash); task-completion capability varies. _Last verified: v0.130 (tested-model list matches the README); star ratings and agent-baseline percentages date from the 2026-08 baselines, and `—` marks a model added since without a star rating._

## Recommended local models (Ollama)

| Model                 | Size   | Agent rating | Notes                                                                                                                       |
| --------------------- | ------ | ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `gemma4:e4b`          | 9.6 GB | ★★★★★        | The default. Best all-round agent: 96% on the 70-case agent baseline (2026-08), clean tool calling, most-dogfooded.         |
| `gemma4:31b`          | 20 GB  | —            | The most capable local model tested. Needs a 32 GB GPU — see [the memory caveat](#running-gemma4-31b-on-a-32-gb-gpu) below. |
| `ornith:9b`           | 5.6 GB | —            | Best small-footprint agent — near-default capability at a third the size.                                                   |
| `ministral-3`         | 6.0 GB | ★★★★★        | Excellent agent (89% baseline). Completes long multi-step tasks cleanly, but slowly — it needs generous per-case timeouts.  |
| `qwen2.5-coder:7b`    | 4.7 GB | ★★★★         | Reliable coding baseline. Emits text-format tool calls; SideCar's parser recovers them.                                     |
| `north-mini-code:1.0` | 19 GB  | —            | Agentic-tuned coder; strong autonomous, but rarely asks clarifying questions.                                               |
| `laguna-xs-2.1`       | 20 GB  | —            | Fast MoE coder; some run-to-run variance.                                                                                   |
| `granite4.1:3b`       | 2.1 GB | ★★★★         | Remarkably capable for 2 GB — completes multi-step agent tasks. The best choice on low-RAM machines.                        |

Rated in earlier qualification runs but not part of the current tested set:

| Model            | Size  | Agent rating | Notes                                                                                                  |
| ---------------- | ----- | ------------ | ------------------------------------------------------------------------------------------------------ |
| `qwen3.5`        | ~6 GB | ★★★★         | Strong but slower per turn, so long tasks take real time. Good when quality matters more than latency. |
| `deepseek-r1:8b` | ~5 GB | ★★★          | Reasoning model; supported including thinking-mode handling. Slower due to reasoning tokens.           |
| `qwen3:8b`       | ~5 GB | ★★★          | Reasoning model; same profile as deepseek-r1.                                                          |

## Not recommended for agent mode

| Model               | Why                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llama3.2` (2.0 GB) | Fine for chat, but below the agent floor: frequent malformed tool calls and format drift on multi-step tasks. SideCar's recovery layers help it make progress, but `granite4.1:3b` — the same size — is far more capable. |
| `lfm2.5`            | In qualification it reproducibly obeyed a fenced prompt injection.                                                                                                                                                        |

## Cloud backends

For maximum reliability, the Anthropic Claude (direct API or AWS Bedrock), Google Gemini, and Fireworks (DeepSeek) backends are the strongest tested cloud options. OpenRouter, Groq, and other OpenAI-compatible providers also work — capability tracks the underlying model. Every agent request carries about 11.5K tokens of system prompt and tool definitions, so small tokens-per-minute limits fail outright: Groq's free tier (8K TPM) rejects every agent request with `413`.

## Hardware guidance

Local models were first qualified on an Apple M3 Max with 36 GB of unified memory; current testing runs on a Windows workstation with an NVIDIA RTX 5090 (32 GB VRAM) and 128 GB of system RAM, both through Ollama.

- **Apple Silicon (36 GB unified memory):** sub-10 GB models run comfortably alongside VS Code with headroom for the context cache; the ~19–20 GB MoE coders fit with less room to spare. A dense 14B model at a large context window can exceed unified memory and thrash — lower `sidecar.ollama.numCtx`, or prefer a smaller coder.
- **Discrete GPU:** what matters is VRAM, not system RAM. The model's weights _and_ its context cache must fit on the GPU, or Ollama moves layers to the CPU and generation slows sharply. The context cache grows with the window — `gemma4:e4b` at its full 131K context needs about 10 GB of VRAM.
- Unload a large model before loading another (`ollama ps` / `ollama stop <model>`); two resident large models can starve the second load.
- SideCar clamps requested context windows (`num_ctx`) to avoid OOM on low-VRAM hardware, and caps the system-prompt budget for local models so small models aren't overwhelmed.

### Running gemma4 31b on a 32 GB GPU

`gemma4:31b` at 131K context only just fits a 32 GB card. When other applications hold GPU memory, Windows can move part of the model into system RAM without any error, and prompt processing slows by about 10×, even though `ollama ps` still reports 100% GPU. If it runs slowly, close other GPU-heavy applications and lower `sidecar.ollama.numCtx` before switching models.

## How SideCar levels the field

Local models make format mistakes that cloud models don't. SideCar's harness converts many of them into working calls instead of errors: text-format tool-call parsing (XML, fenced JSON, bare JSON), tool-name aliasing (`create_file` → `write_file`), parameter-name recovery (`file` → `path`), creation-intent coercion for `edit_file` on missing files, and schema-carrying error messages.

Specific repairs are shown to be load-bearing: text-protocol parsing is what lets `qwen2.5-coder` call tools at all, and string-to-array coercion is what makes `llama3.2`'s `ask_user` calls valid. That the stack as a whole makes a local model better at real tasks is **not established** — see [Measured, not claimed](https://github.com/nedonatelli/sidecar#measured-not-claimed) in the README.
