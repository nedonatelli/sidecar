---
title: Home
layout: home
nav_order: 1
---

<p align="center">
  <img src="assets/logo.png" alt="SideCar Logo" width="200">
</p>

# SideCar

**A free, open-source, local-first AI coding assistant for VS Code.**

SideCar is a VS Code extension that serves as a drop-in replacement for GitHub Copilot and Claude Code. Use local [Ollama](https://ollama.com) models or the [Anthropic API](https://api.anthropic.com) for AI-powered coding — with full agentic capabilities, inline completions, and tool use.

No subscriptions. No data leaving your machine. No vendor lock-in.

---

## How SideCar compares

Most local AI extensions for VS Code are chat wrappers or autocomplete plugins. SideCar is a **full agentic coding assistant** — closer to Claude Code or Cursor than to a chatbot.

| Capability | SideCar | Continue | Llama Coder | Twinny | Copilot (free) |
|---|---|---|---|---|---|
| Chat with local models | Yes | Yes | No | Yes | Yes |
| Inline completions | Yes | Yes | Yes | Yes | Yes |
| Autonomous agent loop | **Yes** | No | No | No | No |
| File read/write/edit tools | **Yes** | No | No | No | No |
| Run commands & tests | **Yes** | No | No | No | No |
| Security & secrets scanning | **Yes** | No | No | No | No |
| MCP server support | **Yes** | No | No | No | No |
| Git integration (commit, PR) | **Yes** | No | No | No | No |
| Diff preview & undo/rollback | **Yes** | No | No | No | No |
| Fully offline / self-hosted | Yes | Yes | Yes | Yes | No |
| Free & open-source | Yes | Yes | Yes | Yes | Freemium |

---

## Quick start

1. Install [Ollama](https://ollama.com)
2. Install [SideCar from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nedonatelli.sidecar-ai)
3. Click the SideCar icon in the activity bar
4. Start chatting — SideCar launches Ollama automatically

See the [Getting Started](getting-started) guide for more details.

---

## Requirements

- **[Ollama](https://ollama.com)** installed and in your PATH (for local models)
- **Visual Studio Code** 1.88.0 or later
