---
title: "ADR-001: Local-first architecture via Ollama"
layout: docs
---

# ADR-001: Local-first architecture via Ollama

**Date**: 2024-09
**Status**: Accepted

## Context

Agent-mode coding assistants (Copilot, Cursor, Claude Code) all require paid cloud API access. A VS Code extension that wires directly into a local LLM server can deliver equivalent capability at zero marginal cost. The primary target backend was Ollama, which runs on consumer hardware and exposes an OpenAI-compatible HTTP API at `localhost:11434`.

The decision also needed to account for developers who work air-gapped, handle sensitive codebases, or simply want no data leaving their machine.

## Decision

SideCar is local-first: Ollama is the default backend, and every feature must work without internet access. Cloud backends (Anthropic, OpenAI, OpenRouter, Groq, Fireworks, Kickstand) are supported as optional overlays through the same `ApiBackend` interface, selectable via `sidecar.baseUrl`. No feature may silently require a cloud call when the user is on a local backend.

The `ApiBackend` abstraction (`src/ollama/backend.ts`) keeps the agent loop backend-agnostic: `streamChat(model, systemPrompt, messages, signal, tools)` is the only method the loop calls.

## Consequences

**Positive**:
- Zero subscription cost for users on Ollama
- Full offline operation — no telemetry, no data egress
- Easy to test locally; no API keys needed for development
- Broadens audience beyond developers who can expense cloud credits

**Negative**:
- Local model capability ceiling is lower than frontier models for complex tasks; the extension must be robust to weaker tool-calling behavior (fallback text parsers, cycle detection, stub guards)
- Ollama's API surface differs from Anthropic's in ways that require per-backend adapters (prompt caching, thinking blocks, structured tool schemas)
- Feature gating by provider (e.g. `delegate_task` only on paid backends, extended thinking only on Anthropic) adds complexity to tool registration
