---
title: Inline Chat & Completions
layout: docs
nav_order: 5
nav_section: "Agent"
---

# Inline Chat & Completions

## Inline chat (`Cmd+I`)

Press `Cmd+I` (Mac) or `Ctrl+I` (Windows/Linux) to open an inline prompt directly in the editor.

1. Select code (optional) — if you have a selection, SideCar uses it as context
2. Press `Cmd+I` and describe the change: "convert to async/await", "add error handling", "translate to TypeScript"
3. The proposed replacement streams into a **side-by-side diff preview** — original on the left, proposal on the right
4. An **Accept / Dismiss** dialog gates the final apply — nothing lands in your file until you accept

Inline chat uses the same model as the sidebar chat. It supports thinking models (reasoning blocks are shown collapsed). All tool use is disabled — inline chat is a focused edit, not an agent run.

### Lightbulb integration

When VS Code shows a diagnostic (red/yellow squiggle), pressing `Cmd+.` / `Ctrl+.` surfaces two SideCar actions alongside the built-in Quick Fixes:

- **Fix with SideCar** — explains the error and proposes a corrective edit via inline chat
- **Explain this error with SideCar** — sends the diagnostic to the sidebar chat for a detailed explanation

**Refactor with SideCar** appears in the Refactor submenu (`Cmd+Shift+R` / right-click → Refactor) for any selection.

---

## Inline completions (FIM)

Copilot-style autocomplete as you type. **Opt-in** — enable it:

```json
"sidecar.enableInlineCompletions": true
```

Press `Tab` to accept a suggestion, `Escape` to dismiss. Completions are debounced (default 300 ms) with in-flight cancellation so they don't pile up while you type.

### Backend paths

SideCar routes completions differently per backend:

| Backend | Completion method | Notes |
|---------|-------------------|-------|
| Ollama | FIM endpoint (`/api/generate` with `suffix`) | Requires a model with FIM support (qwen2.5-coder, codestral, deepseek-coder) |
| Kickstand | Native FIM path (`ks_build_fim_tokens`) | Grammar-constrained; fastest local option |
| Anthropic | Messages API with fill-in context | No native FIM; less accurate for mid-file insertions |
| OpenAI-compat | `/v1/completions` FIM if available, else chat | Depends on the server |

Not all Ollama models support FIM — models without a `<|fim_prefix|>` / `<|fim_suffix|>` / `<|fim_middle|>` token set fall back to the chat API and produce lower-quality suggestions.

### Speculative decoding (v0.110+)

When enabled, a small draft model proposes tokens that the main model verifies — delivering main-model quality at draft-model latency.

```json
"sidecar.speculativeDecoding.enabled": true,
"sidecar.completionDraftModel": "qwen2.5-coder:0.5b"
```

Leave `completionDraftModel` empty to auto-discover the smallest available model on the active backend. SideCar tracks the rolling accept rate and auto-disables speculative decoding if it falls below `sidecar.speculativeDecoding.minAcceptRateToKeepEnabled` (default `0.4`).

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `sidecar.enableInlineCompletions` | `false` | Enable FIM autocomplete |
| `sidecar.completionModel` | `""` | Separate model for completions (empty = use chat model) |
| `sidecar.completionMaxTokens` | `256` | Max tokens per completion |
| `sidecar.completionDebounceMs` | `300` | Minimum ms between requests |
| `sidecar.speculativeDecoding.enabled` | `true` | Enable speculative draft-verify pipeline |
| `sidecar.completionDraftModel` | `""` | Draft model for speculative decoding |
| `sidecar.speculativeDecoding.lookahead` | `4` | Draft tokens proposed per cycle (1–16) |

### Tips

- Point `sidecar.completionModel` at a small fast model (`qwen2.5-coder:1.5b`, `deepseek-coder:1.3b`) while keeping a larger model for the sidebar agent — completions are latency-sensitive, chat turns are not
- For Kickstand, `sidecar.kickstand.flashAttn: true` gives a 2–4× speed boost on long contexts with Metal or CUDA, which helps completion latency
- Lower `completionDebounceMs` for snappier suggestions at the cost of more GPU pressure

---

## Next Edit Suggestions (v0.72+)

After you edit a symbol, SideCar walks the symbol graph to find callers and dependents that likely need the same update. Candidates appear as ghost-text badge decorations (①②③) at the affected lines; cross-file hits show in the status bar.

Enable it:

```json
"sidecar.nextEdit.enabled": true
```

| Key | Action |
|-----|--------|
| `Tab` | Accept the highlighted suggestion |
| `Alt+↓` / `Alt+↑` | Cycle through suggestions |
| `Escape` | Dismiss all suggestions |

Settings: `sidecar.nextEdit.{debounceMs, crossFileEnabled, maxHops, topK, autoTriggerOnSave}` — see [Configuration → Next Edit Suggestions](configuration#next-edit-suggestions-v072).

---

## Adaptive Paste (v0.72+)

When you paste foreign content into a file, SideCar detects the content type and offers a lightbulb code action to transform it to fit the target language. Detection is heuristic — no LLM call fires until you accept.

Built-in transforms: JSON → TypeScript type, SQL → ORM query, curl → `fetch()`, CSS → Tailwind classes, Python → TypeScript, shell → `child_process`, `.env` → Zod schema.

Enable/disable via `sidecar.adaptivePaste.enabled` (default `true`). Set a minimum paste length with `sidecar.adaptivePaste.minPasteLength` (default `50` chars) to avoid triggering on short snippets.

---

## Code actions

Right-click on selected code (or press `Cmd+.` / `Ctrl+.`) to access SideCar code actions:

| Action | What it does |
|--------|-------------|
| **Explain with SideCar** | Sends the selection to the sidebar chat with "Explain this code" |
| **Fix with SideCar** | Sends the selection and any related diagnostic with "Fix this code" |
| **Refactor with SideCar** | Sends the selection with "Refactor this code for clarity and maintainability" |
| **Add tests with SideCar** | Generates a test file for the selected function or class |

All actions send to the sidebar agent which has its full tool set available — it can read related files, run tests, and iterate.

---

## @ references

Use `@` syntax in chat messages to include specific context:

| Syntax | Description |
|--------|-------------|
| `@file:src/index.ts` | Include a specific file's contents |
| `@folder:src/utils/` | Include all files in a directory |
| `@symbol:MyClass` | Include the definition of a symbol |
| `@pin:src/types.ts` | Pin this file to always be included |

References are resolved before sending the message to the model. Use them when the automatic workspace context doesn't include what you need.

---

## Image support

Attach images to chat messages for vision-capable models:

- Click the **paperclip** button to attach the active file or browse for an image
- Paste a screenshot directly into the chat input
- Supported formats: PNG, JPG, GIF, BMP, WebP, SVG

Useful for describing a UI to build, showing an error screenshot for debugging, or comparing a mockup to current code. Requires a vision-capable model — Claude 3+, GPT-4o, or a local vision model like `llava`.
