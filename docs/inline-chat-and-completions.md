---
title: Inline Chat & Completions
layout: docs
nav_order: 10
---

# Inline Chat & Completions

## Inline chat (Cmd+I)

Press `Cmd+I` (Mac) or `Ctrl+I` (Windows/Linux) to open inline chat directly in the editor.

- **Edit selected code** — select code, press `Cmd+I`, and describe the change (e.g., "convert to async/await")
- **Insert at cursor** — place your cursor and describe what to generate
- **Context-aware** — SideCar includes the surrounding code for better edits

Inline chat uses the same model as the sidebar chat.

## Inline completions

SideCar provides Copilot-like autocomplete as you type. This is **opt-in** — enable it in settings:

```json
"sidecar.enableInlineCompletions": true
```

### How it works

- **Ollama models**: Uses the Fill-in-the-Middle (FIM) endpoint for accurate completions
- **Anthropic models**: Falls back to the Messages API
- Completions are debounced (default 300ms) with in-flight cancellation to avoid overloading your machine
- Press `Tab` to accept a suggestion, `Escape` to dismiss

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `sidecar.enableInlineCompletions` | `false` | Turn on autocomplete |
| `sidecar.completionModel` | `""` | Use a different model for completions (leave empty for chat model) |
| `sidecar.completionMaxTokens` | `256` | Max tokens per completion |
| `sidecar.completionDebounceMs` | `300` | Minimum ms between requests |

### Tips

- Use a smaller, faster model for completions (e.g., `qwen2.5-coder:7b`) while keeping a larger model for chat
- Lower `completionDebounceMs` for faster suggestions (at the cost of more CPU/GPU usage)
- Higher `completionMaxTokens` allows longer suggestions but takes more time

## Code actions

Right-click on selected code to access SideCar code actions:

- **Explain with SideCar** — sends the selection to chat with an "Explain this code" prompt
- **Fix with SideCar** — sends the selection with a "Fix this code" prompt
- **Refactor with SideCar** — sends the selection with a "Refactor this code" prompt

The selected code and the action are sent to the sidebar chat, where the agent can use its full tool set to respond.

## @ references

Use `@` syntax in chat messages to include specific context:

| Syntax | Description |
|--------|-------------|
| `@file:src/index.ts` | Include a specific file's contents |
| `@folder:src/utils/` | Include all files in a directory |
| `@symbol:MyClass` | Include the definition of a symbol |

References are resolved before sending the message to the model. Use them when the automatic workspace context doesn't include what you need.

## Image support

Attach images to chat messages for vision-capable models:

- Click the **paperclip** button to attach the active file or browse for an image
- Paste a screenshot directly into the chat input
- Supported formats: PNG, JPG, GIF, BMP, WebP, SVG

Useful for:
- Describing a UI you want to build
- Showing an error screenshot for debugging
- Comparing a mockup to current code
