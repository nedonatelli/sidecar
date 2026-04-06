---
title: Getting Started
layout: default
nav_order: 2
---

# Getting Started

## Install Ollama

Download and install [Ollama](https://ollama.com) for your platform. After installation, verify it's working:

```bash
ollama --version
```

Pull a recommended model:

```bash
ollama pull qwen3-coder:30b
```

## Install SideCar

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nedonatelli.sidecar-ai), or search for "SideCar" in the VS Code Extensions panel (`Cmd+Shift+X` / `Ctrl+Shift+X`).

## Your first chat

1. Click the **SideCar** icon in the activity bar (left sidebar)
2. Type a message in the chat input
3. SideCar auto-launches Ollama if it's not already running

SideCar will automatically include your active file and workspace context in the conversation.

## Choosing a model

Use the model dropdown at the top of the chat panel to browse and switch models. Models are organized into two categories:

- **Full Features (Tools)** — models that support function calling (e.g., `qwen3-coder`, `llama3.1`, `command-r`)
- **Chat-Only** — models that work for conversation but can't use tools (e.g., `gemma2`, `llama2`, `mistral`)

You can also install new models directly from the dropdown — SideCar will pull them from the Ollama registry.

The default model is `qwen3-coder:30b`. For machines with less RAM, try `qwen3-coder:8b` or `qwen2.5-coder:7b`.

## Using the Anthropic API

To use Claude models instead of local Ollama:

1. Set `sidecar.baseUrl` to `https://api.anthropic.com`
2. Set `sidecar.apiKey` to your Anthropic API key
3. Set `sidecar.model` to a Claude model (e.g., `claude-sonnet-4-6`)

SideCar uses prompt caching with Anthropic, reducing input token costs by ~90% on cache hits.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+I` / `Ctrl+Shift+I` | Toggle SideCar chat panel |
| `Cmd+I` / `Ctrl+I` | Inline chat (edit code in place) |
| `Cmd+L` / `Ctrl+L` | Clear chat |
| `Cmd+Shift+U` / `Ctrl+Shift+U` | Undo all AI changes |
| `Cmd+Shift+E` / `Ctrl+Shift+E` | Export chat as Markdown |
