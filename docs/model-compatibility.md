---
title: Model Compatibility
layout: docs
nav_order: 4
nav_section: 'Get Started'
---

# Model Compatibility

SideCar works with any model your backend can serve, but agentic coding is demanding: a model must call tools reliably, follow multi-step instructions, and recover from errors. This page lists what we actually measure, so you can pick a model that matches your hardware and expectations.

Ratings come from SideCar's own evaluation suite — an agent-loop smoke suite (file reading, searching, editing, bug-fix cycles) plus long-horizon multi-step tasks — re-run against local models as SideCar evolves. _Last verified: v0.123 (sizes + agent-baseline ratings against the 2026-08 five-model baselines)._

## Recommended local models (Ollama)

| Model              | Size    | Agent rating | Notes                                                                                                                      |
| ------------------ | ------- | ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `gemma4:e4b`       | ~9 GB   | ★★★★★        | The default. Best all-round agent: 96% on the 70-case agent baseline (2026-08), clean tool calling, most-dogfooded.        |
| `ministral-3`      | ~6 GB   | ★★★★★        | Excellent agent (89% baseline). Completes long multi-step tasks cleanly, but slowly — it needs generous per-case timeouts. |
| `qwen2.5-coder:7b` | ~4.7 GB | ★★★★         | Reliable coding baseline. Emits text-format tool calls that SideCar's parser recovers to native-grade reliability.         |
| `granite4.1:3b`    | ~2 GB   | ★★★★         | Remarkably capable for 2 GB — completes multi-step agent tasks. The best choice on low-RAM machines.                       |
| `qwen3.5`          | ~6 GB   | ★★★★         | Strong but slower per turn, so long tasks take real time. Good when quality matters more than latency.                     |
| `deepseek-r1:8b`   | ~5 GB   | ★★★          | Reasoning model; supported including thinking-mode handling. Slower due to reasoning tokens.                               |
| `qwen3:8b`         | ~5 GB   | ★★★          | Reasoning model; same profile as deepseek-r1.                                                                              |

## Not recommended for agent mode

| Model           | Why                                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llama3.2` (3B) | Fine for chat, but below the agent floor: frequent malformed tool calls and format drift on multi-step tasks. SideCar's recovery layers help it make progress, but `granite4.1:3b` — the same size — is far more capable. |

## Cloud backends

Anthropic Claude models (direct API or AWS Bedrock) are the strongest option for agent mode when a cloud backend is acceptable. Any OpenAI-compatible provider (OpenRouter, Groq, Fireworks, Gemini) also works — capability tracks the underlying model. Note that free-tier token-per-minute limits on some providers are too small for agentic workloads.

## Hardware guidance

- Model size ≲ 1/3 of unified/system RAM is a safe rule of thumb — e.g. models up to ~12 GB on a 36 GB machine. Larger risks OOM when other apps hold memory.
- Unload a large model before loading another (`ollama ps` / `ollama stop <model>`); two resident large models can starve the second load.
- SideCar clamps requested context windows (`num_ctx`) to avoid OOM on low-VRAM hardware, and caps the system-prompt budget for local models so small models aren't overwhelmed.

## How SideCar levels the field

Local models make format mistakes that cloud models don't. SideCar's harness converts many of them into working calls instead of errors: text-format tool-call parsing (XML, fenced JSON, bare JSON), tool-name aliasing (`create_file` → `write_file`), parameter-name recovery (`file` → `path`), creation-intent coercion for `edit_file` on missing files, and schema-carrying error messages. A mid-tier local model on SideCar is meaningfully more reliable than the same model on a thin harness — that's the point of running one.
