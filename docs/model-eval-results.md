---
title: Model Eval Results
layout: docs
nav_order: 15
---

# Model Eval Results

SideCar ships a deterministic LLM evaluation harness (`npm run eval:llm`) that measures how well each model follows the system prompt and completes real agentic tasks. Results below are produced by running the harness against each backend and model.

## What the eval measures

The suite has two layers:

**Agent cases (47 total)** — the model runs inside the full agent loop with real tools against a sandboxed workspace. Cases test tool selection, file editing, code quality, error recovery, and operating rules (e.g. run tests after a fix, use `search_files` not `list_directory + filter`).

**Prompt cases (31 total)** — the model is tested against the base system prompt without tool calls: identity, honesty, conciseness, language mirroring, injection resistance, retrieval citation, and tool preference rules.

Cases are scored deterministically (string matching, regex, trajectory inspection — no LLM-as-judge). A case passes only when every expectation holds. Some expectations use `softExpect` (reported but not counted toward pass/fail) for answer-quality checks where the core behavioral signal is in the trajectory.

## Results

> Last updated: 2026-05-09. Run with `SIDECAR_EVAL_CASE_TIMEOUT=300000` for local models, `120000` for cloud.
> **Suite v0.87b** (47 agent + 34 prompt = 81 cases) — current; adds `rule5-no-alternatives-menu` and `rule9-ambiguous-target` + `rule9-meta-knowledge` prompt cases; includes prompt fixes for Rule 3/5/9.
> **Suite v0.87a** (47 agent + 32 prompt = 79 cases) — pre-Rule5/9-fix run; rows marked with ‡.
> **Suite v0.87** (47 agent + 31 prompt = 78 cases) — pre-`rule9-ambiguous-target` run; rows marked with ‡‡.
> Scores reflect the test suite at time of run; re-run models after any structural fix to get current numbers.
> Rows marked ‡ are from the v0.87a suite (79 cases); rows marked ‡‡ are from the v0.87 suite (78 cases) — both need re-running on v0.87b.
> Rows marked †v0.87 are from the old 56-case suite (32 agent + 24 prompt) and need re-running. Prompt denominator may vary by backend (some cases are backend-specific or skipped when a case times out).

| Model | Backend | Size | Agent | Prompt | Total | Notes |
|-------|---------|------|-------|--------|-------|-------|
| **deepseek-v4-pro** | Fireworks | — | 45/47 (96%) | 30/32 (94%) | **75/79 (95%)** ‡ | Suite v0.87a. Highest total score; plan-mode-no-tools + error-recovery are agent fails; rule13/plan-mode are sole prompt fails; 1M token context |
| **claude-haiku-4-5-20251001** | Anthropic | — | 45/47 (96%) | 32/34 (94%) | **77/81 (95%)** | Suite v0.87b. +1 agent (ask-user-ambiguous-rename fixed by Rule 9 prompt change); +3 prompt (2 new cases pass + rule7/rule5 were false positives fixed in regex); real fails: error-recovery + cautious-mode agent; rule3 + plan-mode prompt |
| **x-ai/grok-3-mini** | OpenRouter | — | 42/47 (89%) | 28/32 (87.5%) | **70/79 (89%)** ‡ | Suite v0.87a. Strong agent; fails error-recovery, rename-across-callers, export-barrel, grep-regex, run-tests-iterate; prompt fails rule3/rule8/plan-mode |
| **gemma4:e4b** | Ollama | 9 GB | 37/47 (79%) | 29/34 (85%) | **66/81 (81%)** | Suite v0.87b. +3 agent / +2 prompt vs v0.87a run; edit_file no-op + partial-replace fixes account for agent gains; 10 agent + 5 prompt real failures; rule5/rule9-ambiguous-target new cases both pass |
| **ministral-3:latest** | Ollama | 6 GB | 46/47 (98%) | 20/32 (62%) | **66/79 (84%)** ‡ | Suite v0.87a. Highest agent score of all models tested; sole agent fail is multi-tool-iteration; prompt weaker on rule3/rule7/rule13/rule2/rule4/plan-mode — typical small-model instruction-following gap; requires 600 s case timeout (model is slow) |
| **gemini-2.5-flash** | Gemini | — | 44/47 (94%) | 23/31 (74%) | **67/78 (86%)** ‡‡ | Suite v0.87. Strong agent; prompt weaker on rule2/rule3/rule10/rule13 honesty/freshness tests; rename-function + error-recovery + ask-user-ambiguous-rename fail |
| **qwen/qwen3-235b-a22b** | OpenRouter | — | 40/47 (85%) | 23/31 (74%) | **63/78 (81%)** ‡‡ | Suite v0.87. Prompt dropped on new rule2/rule4/rule13 cases; error-recovery, grep-regex, multi-tool-iteration common agent fails |
| **granite4.1:3b** | Ollama | 2 GB | 25/31 (81%) | 19/23 (83%) | **44/61 (72%)** | †v0.87 scores — re-run needed. Punches well above its weight; 2 cases scraped the 300s timeout |
| **qwen3.5:latest** | Ollama | 6 GB | 22/32 (69%) | 21/24 (88%) | **43/56 (77%)** | †v0.87 scores — re-run needed. Strong prompt adherence; loses version-from-package-json (reads file, answers wrong field) |
| **mistral-large-2411** | OpenRouter | — | partial | partial | **~63/78** ‡‡ | Suite v0.87. Result unreliable — ~4+ agent cases hit upstream 429 rate limits; real behavioral failures: multi-tool-iteration, error-recovery, ask-user-ambiguous-rename + 5 prompt cases |
| **gpt-4.1-mini** | OpenAI | — | partial | partial | **~40/78** ‡‡ | Suite v0.87. Result unreliable — many cases hit 200K TPM limit; agent score was ~51%; strong prompt adherence where it ran |
| **gpt-4o-mini** | OpenAI | — | 15/31 (48%) | 16/22 (73%) | **~35/57 (61%)** | †v0.87 scores — re-run needed. Underperforms its size; struggles with complex tool-use cases |
| **gpt-4o** | OpenAI | — | ❌ rate limited | — | — | Free tier 30K TPM; our prompt+tools is ~23K tokens, exhausted after 1 case |
| **meta-llama/llama-4-maverick** | OpenRouter | — | ❌ no tool use | — | — | OpenRouter routing for this model has no tool-use endpoint; 404 on all agent cases |
| **llama-4-scout-17b-16e-instruct** | Groq | — | ❌ rate limited | — | — | Free tier 30K TPM; same constraint as gpt-4o above |
| **llama-3.3-70b-versatile** | Groq | — | ❌ rate limited | 17/22 (77%) | — | Free tier 12K TPM; too small even for a single request |
| **llama-v3p3-70b-instruct** | Fireworks | — | ❌ context exceeded | 15/22 (68%) | — | Prompt is 131,473 tokens; model limit is 131,072 — 401 tokens over |
| **glm-4.7-flash** | Ollama | 19 GB | ❌ too slow | — | — | Prefill >300s on 36 GB hardware; parser bug fixed (message.thinking field) |
| **laguna-xs.2** | Ollama | 23 GB | ❌ incompatible | — | — | Freezes when tool schemas are included in the request |

## Models confirmed not working

| Model | Backend | Reason |
|-------|---------|--------|
| `meta-llama/llama-4-maverick` | OpenRouter | No tool-use endpoint available via OpenRouter routing (404 on every agent case) |
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
| `error-recovery-to-correct-file` | all tested | Model finds the candidate file via `list_directory` but asks "would you like me to read it?" instead of reading immediately — Rule 5 strengthened in v0.87 to close this gap |
| `ask-user-ambiguous-rename` | all tested | Model guesses which of two candidate functions the user meant and edits it, then hedges "let me know if you meant the other one" — Rule 9 updated in v0.87 to explicitly cover the singular-target / multiple-candidates case |
| `grep-regex-pattern` | all tested | Model reads every file individually instead of using `grep` with a regex to search across files |
| `rule7-no-tool-narration` | haiku, gemma4, gpt-4o-mini, qwen3.5 | Model emits filler text between consecutive tool calls |
| `plan-mode-no-tools` | deepseek, qwen3-235b | Model says "let me explore first" and calls tools instead of producing the plan directly |
| `plan-mode-behavior` (prompt) | deepseek, qwen3-235b, gemma4 | Model does not describe ExitPlanMode or plan-then-present behavior when explaining plan mode |
| `rule13-no-invented-url` / `package-version-not-invented` | deepseek, qwen3-235b | Model fabricates a URL or package version it has not seen in context |
| `edit_file` search-string mismatch | gpt-4.1-mini | Model reports success after `edit_file` returns a search-not-found error instead of retrying |
| `edit_file` no-op (search == replace) | gemma4 (pre-v0.89.1) | Model populated `replace` with the same text as `search` — silent success, file unchanged. Fixed by adding a guard that returns an error when `search === replace`, which lets models that understand error recovery (like gemma4) retry correctly |
| `edit_file` partial replace (replace ⊂ search) | gemma4 | Model puts a substring of the search string as the replacement (e.g. search = full function signature, replace = `"string"`), silently truncating the file. A warning is now appended to the success response when replace is < 50% of search length and appears verbatim inside it — prompts the model to re-read and self-correct |
| `rule2/rule4` (new) | qwen3-235b | Rule 2 (name the tool, don't guess inline) and Rule 4 (relative paths) — qwen3-235b fails both on the new prompt cases |
| `run-tests-fail-fix-iterate` (multi-bug) | qwen3-235b | Multi-iteration fix loop (fix bug 1 → re-run → fix bug 2) times out at 120 s for large cloud models |
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
