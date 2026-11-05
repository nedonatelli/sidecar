---
title: Inline Chat & Completions
layout: docs
nav_order: 5
nav_section: 'Agent'
---

# Inline Chat & Completions

## Inline chat (`Cmd+I`)

Press `Cmd+I` (Mac) or `Ctrl+I` (Windows/Linux) to open an inline prompt directly in the editor.

1. Select code (optional) — if you have a selection, SideCar uses it as context
2. Press `Cmd+I` and describe the change: "convert to async/await", "add error handling", "translate to TypeScript"
3. SideCar generates the replacement behind a cancellable "generating edit..." notification; once it finishes, a **side-by-side diff preview** opens — original on the left, proposal on the right
4. A modal **Accept** dialog gates the final apply — nothing lands in your file until you accept, and cancelling the dialog discards the proposal

Inline chat uses the same model as the sidebar chat. Only the model's answer text is used: reasoning from thinking models isn't shown. All tool use is disabled — inline chat is a focused edit, not an agent run.

### Lightbulb integration

When VS Code shows a diagnostic (red/yellow squiggle), pressing `Cmd+.` / `Ctrl+.` surfaces two SideCar actions alongside the built-in Quick Fixes:

- **Fix with SideCar** — sends the diagnostic and its line to the sidebar chat with a request to fix it
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

| Backend       | Completion method                             | Notes                                                                        |
| ------------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| Ollama        | FIM endpoint (`/api/generate` with `suffix`)  | Requires a model with FIM support (qwen2.5-coder, codestral, deepseek-coder) |
| Anthropic     | Messages API with fill-in context             | No native FIM; less accurate for mid-file insertions                         |
| OpenAI-compat | Chat completion with fill-in context          | No FIM endpoint is used                                                      |

Not all Ollama models support FIM — models without a `<|fim_prefix|>` / `<|fim_suffix|>` / `<|fim_middle|>` token set fall back to the chat API and produce lower-quality suggestions.

### Speculative decoding (v0.110+)

For local inline completions on Ollama, SideCar can race a small draft model against the main model: both get the same FIM request, the first to finish supplies the completion, and the other is aborted. There is no draft-then-verify step, so a draft win returns the draft model's own output.

```json
"sidecar.speculativeDecoding.enabled": true,
"sidecar.completionDraftModel": "qwen2.5-coder:0.5b"
```

Leave `completionDraftModel` empty to use the draft paired with your main model in SideCar's built-in table (for example `qwen2.5-coder:0.5b` for the `qwen2.5-coder` and `qwen3-coder` models); a model with no pair in the table runs without a race. After 10 races, SideCar stops using the table's draft for the session if the draft's win rate falls below `sidecar.speculativeDecoding.minAcceptRateToKeepEnabled` (default `0.4`). A `completionDraftModel` you set always races — even with `speculativeDecoding.enabled` off or after that cutoff. Other backends use the chat path and never race.

### Settings

| Setting                               | Default | Description                                             |
| ------------------------------------- | ------- | ------------------------------------------------------- |
| `sidecar.enableInlineCompletions`     | `false` | Enable FIM autocomplete                                 |
| `sidecar.completionModel`             | `""`    | Separate model for completions (empty = use chat model) |
| `sidecar.completionMaxTokens`         | `256`   | Max tokens per completion                               |
| `sidecar.completionDebounceMs`        | `300`   | Minimum ms between requests                             |
| `sidecar.speculativeDecoding.enabled` | `true`  | Enable speculative draft-verify pipeline                |
| `sidecar.completionDraftModel`        | `""`    | Draft model for speculative decoding                    |

### Tips

- Point `sidecar.completionModel` at a small fast model (`qwen2.5-coder:1.5b`, `deepseek-coder:1.3b`) while keeping a larger model for the sidebar agent — completions are latency-sensitive, chat turns are not
- Lower `completionDebounceMs` for snappier suggestions at the cost of more GPU pressure

---

## Next Edit Suggestions (v0.72+)

After you edit a symbol, SideCar walks the symbol graph to find callers and dependents that likely need the same update. Candidates appear as ghost-text badge decorations (①②③) at the affected lines; cross-file hits show in the status bar.

Enable it:

```json
"sidecar.nextEdit.enabled": true
```

The Next Edit commands ship without default keybindings — run them from the Command Palette (`SideCar: Next Edit: Jump to First Suggestion`, `… Go to Next Suggestion`, `… Go to Previous Suggestion`, `… Dismiss Suggestions`) or bind your own keys in Keyboard Shortcuts.

Settings: `sidecar.nextEdit.{debounceMs, crossFileEnabled, maxHops, topK, autoTriggerOnSave}` — see [Configuration → Next Edit Suggestions](configuration#next-edit-suggestions-v072).

---

## Adaptive Paste (v0.72+)

When you paste foreign content into a file, SideCar detects the content type and offers a lightbulb code action to transform it to fit the target language. Detection is heuristic — no LLM call fires until you accept.

Built-in transforms: JSON → TypeScript type, SQL → ORM query, curl → `fetch()`, CSS → Tailwind classes, Python → TypeScript, shell → `child_process`, `.env` → Zod schema.

Before the transformed code replaces your paste, SideCar opens a diff of the file with the change applied and asks you to **Accept** or **Reject**. Nothing changes until you accept. In `autonomous` mode (`sidecar.agentMode`) the transform replaces the paste directly, with no preview.

Enable/disable via `sidecar.adaptivePaste.enabled` (default `true`). Set a minimum paste length with `sidecar.adaptivePaste.minPasteLength` (default `50` chars) to avoid triggering on short snippets.

---

## Code actions

Right-click on selected code (or press `Cmd+.` / `Ctrl+.`) to access SideCar code actions:

| Action                     | What it does                                                                  |
| -------------------------- | ----------------------------------------------------------------------------- |
| **Explain with SideCar**   | Sends the selection to the sidebar chat with "Explain this code"              |
| **Fix with SideCar**       | Sends the selection and any related diagnostic with "Fix this code"           |
| **Refactor with SideCar**  | Sends the selection with "Refactor this code for clarity and maintainability" |

All actions send to the sidebar agent which has its full tool set available — it can read related files, run tests, and iterate.

Adding tests is a **CodeLens**, not a code action: the `⚡ Add tests` lens above a function or class puts an "Add unit tests for the following code" prompt in the sidebar chat input for you to review and send. The same lens row offers `⚡ Explain` and `⚡ Refactor`.

---

## @ references

Use `@` syntax in chat messages to include specific context:

| Syntax               | Description                         |
| -------------------- | ----------------------------------- |
| `@file:src/index.ts` | Include a specific file's contents  |
| `@folder:src/utils/` | List a directory's entries (names only, not contents) |
| `@symbol:MyClass`    | Include the definition of a symbol  |
| `@pin:src/types.ts`  | Pin this file to always be included |

References are resolved before sending the message to the model. Use them when the automatic workspace context doesn't include what you need.

---

## Image support

Attach images to chat messages for vision-capable models:

- Click the **paperclip** button to attach the active file or browse for an image
- Paste a screenshot directly into the chat input
- Supported formats: PNG, JPG, GIF, BMP, WebP, SVG

Useful for describing a UI to build, showing an error screenshot for debugging, or comparing a mockup to current code. Requires a vision-capable model — Claude 3+, GPT-4o, or a local vision model like `llava`.
