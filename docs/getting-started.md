---
title: Getting Started
layout: docs
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

## Switching backends

The fastest way to move between Ollama, Anthropic, and Kickstand is the **⚙ gear button** in the chat header. It opens a settings menu with a Backend section — pick a profile and SideCar flips `baseUrl`, `provider`, and `model` in one click. Each profile keeps its own API key in VS Code's SecretStorage, so switching doesn't clobber keys you've already set. The same flow is available from the Command Palette as `SideCar: Switch Backend`.

The sections below describe each backend in detail and also cover the manual settings path if you prefer editing `settings.json`.

## Using the Anthropic API

**Recommended:** click the ⚙ gear → **Anthropic Claude**. SideCar prompts for your API key on first switch, saves it to the Anthropic-specific SecretStorage slot, and sets `baseUrl` / `provider` / `model` for you.

**Manual:**

1. Set `sidecar.baseUrl` to `https://api.anthropic.com`
2. Run `SideCar: Set API Key (SecretStorage)` from the command palette and paste your Anthropic API key
3. Set `sidecar.model` to a Claude model (e.g., `claude-sonnet-4-6`)

SideCar uses prompt caching with Anthropic, reducing input token costs by ~90% on cache hits.

> Note: the Anthropic API is a separate paid service from Claude.ai subscriptions — your Max or Pro plan does not include API credits. Get a key at [platform.claude.com](https://platform.claude.com).

## Using Kickstand

[Kickstand](https://github.com/kickstand/kickstand) is a local inference server that manages model loading, unloading, and GPU memory efficiently. The CLI command is `kick`.

1. Install Kickstand and run `kick init` to set up.
2. Start the server with `kick start`.
3. **Recommended:** click the ⚙ gear → **Kickstand** in the chat header.
   **Manual:** set `sidecar.baseUrl` to `http://localhost:11435` (default Kickstand port).
4. Set `sidecar.model` to the model you want to use.
5. If authentication is required, run `SideCar: Set API Key` — or store your token in `~/.config/kickstand/token` for automatic loading.

SideCar will auto-detect Kickstand by the port number.

## Using OpenAI-compatible servers

SideCar works with any server that exposes the OpenAI `/v1/chat/completions` endpoint — including **LM Studio**, **vLLM**, **llama.cpp**, **text-generation-webui**, and **OpenRouter**.

1. Set `sidecar.baseUrl` to your server's URL (e.g., `http://localhost:1234`)
2. Set `sidecar.apiKey` if required (optional for most local servers)
3. Set `sidecar.model` to the model name your server is running

SideCar auto-detects the provider from the URL. If auto-detection gets it wrong, set `sidecar.provider` explicitly:

```json
"sidecar.provider": "openai"
```

### Provider examples

| Server | Base URL | Notes |
|--------|----------|-------|
| LM Studio | `http://localhost:1234` | Auto-detected as OpenAI |
| vLLM | `http://localhost:8000` | Auto-detected as OpenAI |
| llama.cpp | `http://localhost:8080` | Auto-detected as OpenAI |
| OpenRouter | `https://openrouter.ai/api` | Set API key, access 400+ models |
| text-generation-webui | `http://localhost:5000` | Enable OpenAI extension in the UI |
| Kickstand | `http://localhost:11435` | Auto-detected as Kickstand |
| Ollama | `http://localhost:11434` | Auto-detected as Ollama (native API) |
| Anthropic | `https://api.anthropic.com` | Auto-detected as Anthropic |

### Tool support

Most OpenAI-compatible models support function calling (tool use), which enables SideCar's full agentic capabilities — file editing, shell commands, git operations, etc. If a model doesn't support tools, SideCar falls back to chat-only mode automatically.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+I` / `Ctrl+Shift+I` | Toggle SideCar chat panel |
| `Cmd+I` / `Ctrl+I` | Inline chat (edit code in place) |
| `Cmd+L` / `Ctrl+L` | Clear chat |
| `Cmd+Shift+U` / `Ctrl+Shift+U` | Undo all AI changes |
| `Cmd+Shift+E` / `Ctrl+Shift+E` | Export chat as Markdown |
