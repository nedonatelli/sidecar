---
title: Model Eval Results
layout: docs
nav_order: 15
---

# Model Eval Results

SideCar ships a deterministic LLM evaluation harness (`npm run eval:llm`) that measures how well each model follows the system prompt and completes real agentic tasks. Results below are produced by running the harness against each backend and model.

## What the eval measures

The suite has two layers:

**Agent cases (40 total)** — the model runs inside the full agent loop with real tools against a sandboxed workspace. Cases test tool selection, file editing, code quality, error recovery, and operating rules (e.g. run tests after a fix, use `search_files` not `list_directory + filter`).

**Prompt cases (24 total)** — the model is tested against the base system prompt without tool calls: identity, honesty, conciseness, language mirroring, injection resistance, retrieval citation, and tool preference rules.

Cases are scored deterministically (string matching, regex, trajectory inspection — no LLM-as-judge). A case passes only when every expectation holds. Some expectations use `softExpect` (reported but not counted toward pass/fail) for answer-quality checks where the core behavioral signal is in the trajectory.

## Results

> Last updated: 2026-05-08. Run with `SIDECAR_EVAL_CASE_TIMEOUT=300000` for local models, `120000` for cloud. Suite v0.88 (40 agent + 24 prompt cases).
> Scores reflect the test suite at time of run; re-run models after any structural fix to get current numbers.
> Suite now has 40 agent cases + 24 prompt cases (8 new cases added in v0.88: test-writing, multi-file rename, diagnostics-after-edit, source-reading honesty, barrel-file export, and 3 git-tool-preference cases). Table scores are from v0.87 (32 cases) — re-run to get v0.88 numbers. Prompt denominator may vary by backend (some cases are backend-specific or skipped when a case times out).

| Model | Backend | Size | Agent | Prompt | Total | Notes |
|-------|---------|------|-------|--------|-------|-------|
| **deepseek-v4-pro** | Fireworks | — | 30/32 (94%) | 22/24 (92%) | **52/56 (93%)** | Tied #1; 2 agent timeouts (no-stub-add, fix-type-annotation) not counted in score; 1M token context window |
| **claude-haiku-4-5-20251001** | Anthropic | — | 30/32 (94%) | 22/24 (92%) | **52/56 (93%)** | Tied #1; cautious-mode-completes-task fail was a test assertion bug (now fixed); error-recovery is the one remaining universal pattern |
| **qwen/qwen3-235b-a22b** | OpenRouter | — | 28/32 (87%) | 22/24 (92%) | **50/56 (89%)** | Stream-cancel fix (v0.87) resolved 17+ min abort hangs; 4 agent fails include common error-recovery and multi-tool-iteration patterns |
| **gemini-2.5-flash** | Gemini | — | 28/32 (87%) | 19/24 (79%) | **47/56 (84%)** | Prompt improved +3 from prior run; agent -1 (plan-mode-no-tools new fail); error-recovery and grep-regex-pattern are universal failures |
| **ministral-3:latest** | Ollama | 6 GB | 30/32 (94%) | 13/24 (54%) | **43/56 (77%)** | Best local agent score; prompt highly variable on local hardware (13/24 this run vs 18/23 prior); error-recovery and grep-regex-pattern are the 2 agent fails |
| **granite4.1:3b** | Ollama | 2 GB | 25/31 (81%) | 19/23 (83%) | **44/61 (72%)** | Punches well above its weight; 2 cases scraped the 300s timeout |
| **qwen3.5:latest** | Ollama | 6 GB | 22/32 (69%) | 21/24 (88%) | **43/56 (77%)** | Strong prompt adherence; gains delete-file; loses version-from-package-json (reads file, answers wrong field) |
| **gemma4:e4b** | Ollama | 9 GB | 20/32 (62%) | 21/24 (88%) | **41/56 (73%)** | Strong prompt adherence; edit_file reliability is main weakness — all bug-fix cases fail (claims success but file unchanged); no timeouts post-stream-cancel fix |
| **gpt-4.1-mini** | OpenAI | — | 16/31 (52%) | 20/23 (87%) | **36/54 (67%)** | Underperforms for agent tasks; passed delete-file case; all no-stub cases failed; 2 cases timed out at ~250s |
| **gpt-4o-mini** | OpenAI | — | 15/31 (48%) | 16/22 (73%) | **~35/57 (61%)** | Underperforms its size; struggles with complex tool-use cases |
| **gpt-4o** | OpenAI | — | ❌ rate limited | — | — | Free tier 30K TPM; our prompt+tools is ~23K tokens, exhausted after 1 case |
| **llama-4-scout-17b-16e-instruct** | Groq | — | ❌ rate limited | — | — | Free tier 30K TPM; same constraint as gpt-4o above |
| **llama-3.3-70b-versatile** | Groq | — | ❌ rate limited | 17/22 (77%) | — | Free tier 12K TPM; too small even for a single request |
| **llama-v3p3-70b-instruct** | Fireworks | — | ❌ context exceeded | 15/22 (68%) | — | Prompt is 131,473 tokens; model limit is 131,072 — 401 tokens over |
| **glm-4.7-flash** | Ollama | 19 GB | ❌ too slow | — | — | Prefill >300s on 36 GB hardware; parser bug fixed (message.thinking field) |
| **laguna-xs.2** | Ollama | 23 GB | ❌ incompatible | — | — | Freezes when tool schemas are included in the request |

## Models confirmed not working

| Model | Backend | Reason |
|-------|---------|--------|
| `laguna-xs.2` | Ollama | Freezes completely when tool schemas are present in the request |
| `glm-4.7-flash` | Ollama | Prefill >300s on 36 GB hardware; too slow to be usable |
| `llama-v3p3-70b-instruct` | Fireworks | 401 tokens over the 131,072-token context limit when tool schemas are included |
| `gpt-4o` | OpenAI | Free tier (30K TPM) exhausted after 1 case; requires paid tier |
| `llama-4-scout-17b-16e-instruct` | Groq | Free tier (30K TPM) exhausted after 1 case; requires paid tier |
| `llama-3.3-70b-versatile` | Groq | Free tier (12K TPM) too small for even a single request |
| `qwen3.6` | Ollama | Causes kernel panic (OOM) on 36 GB hardware when loaded alongside other models |

## Known model constraints

**Local model RAM limits:** On a 36 GB unified-memory machine, models larger than ~12 GB risk OOM. Always unload the previous model before loading a large one. `qwen3.6` (23 GB) caused a kernel panic when loaded alongside another model.

**Cloud API rate limits:** SideCar's system prompt + tool schemas totals ~23K tokens per request on typical tokenizers (and up to ~131K on some llama tokenizers when tool schemas are included). Free-tier accounts on OpenAI (30K TPM) and Groq (12K–30K TPM) exhaust their per-minute budget after 1–2 cases, causing the circuit breaker to trip for all subsequent cases. Upgrade to a paid tier, or use the Anthropic backend which has higher free limits.

**Fireworks context limit:** `llama-v3p3-70b-instruct` has a 131,072 token context window. Our prompt + tool schemas lands at 131,473 tokens on the llama tokenizer — 401 tokens over. Prompt-only cases work fine. Use a Fireworks model with a larger context window, or wait for tool-catalog trimming in a future release.

**GLM-style models (`message.thinking`):** Models like GLM-4 emit chain-of-thought in `message.thinking` rather than `<think>` tags inside `message.content`. SideCar v0.87+ handles this correctly. Older versions would silently drop every event, producing empty trajectories.

## Common failure patterns

These failures appear across multiple models and indicate areas for prompt improvement:

| Pattern | Affected models | Description |
|---------|----------------|-------------|
| `rule3-concise-prose` | all tested | Model writes an essay for a simple factual question |
| `rule7-no-tool-narration` | haiku, gpt-4o-mini, groq, qwen3.5 | Model emits filler text between consecutive tool calls |
| `git-tool-preference` | haiku, gpt-4o-mini, groq | Model recommends `run_command git diff` instead of `git_diff` tool |
| `error-recovery-to-correct-file` | all tested | Model finds the candidate file via `list_directory` but asks "would you like me to read it?" instead of reading immediately — Rule 5 strengthened in v0.87 to close this gap |
| `plan-mode-no-tools` | deepseek | Model says "let me explore first" and calls tools instead of producing the plan directly |
| `no-stub-add-function-to-existing-file` | deepseek, gemini (cycle detector) | Model enters a long edit-retry loop; deepseek v4-pro times out, Gemini hits the cycle detector false-positive |
| `version-from-package-json` | qwen3.5 | Model reads the file correctly but answers with the wrong field (e.g. top-level `version` instead of `devDependencies.typescript`) |
| `edit_file` search-string mismatch | gemma4, gpt-4.1-mini | Model reports success after `edit_file` returns a search-not-found error instead of retrying — improved error message in v0.87 helps other models; gemma4 still claims success without modifying the file |
## Running the eval yourself

```bash
# Local Ollama (default — free, no API key needed)
SIDECAR_EVAL_MODEL=ministral-3:latest SIDECAR_EVAL_CASE_TIMEOUT=300000 npm run eval:llm

# Anthropic
SIDECAR_EVAL_BACKEND=anthropic ANTHROPIC_API_KEY=<key> npm run eval:llm

# OpenAI
SIDECAR_EVAL_BACKEND=openai OPENAI_API_KEY=<key> SIDECAR_EVAL_MODEL=gpt-4o npm run eval:llm

# Groq (requires dev tier for agent cases)
SIDECAR_EVAL_BACKEND=groq GROQ_API_KEY=<key> SIDECAR_EVAL_MODEL=meta-llama/llama-4-scout-17b-16e-instruct npm run eval:llm

# Fireworks (use deepseek-v4-pro — default llama model exceeds context limit)
SIDECAR_EVAL_BACKEND=fireworks FIREWORKS_API_KEY=<key> SIDECAR_EVAL_MODEL=accounts/fireworks/models/deepseek-v4-pro npm run eval:llm

# Multi-model comparison table
SIDECAR_EVAL_COMPARE_MODELS="anthropic:claude-haiku-4-5-20251001,ollama:qwen3.5:latest" npm run eval:compare
```
