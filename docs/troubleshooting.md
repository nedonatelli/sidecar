---
title: Troubleshooting
layout: default
nav_order: 12
---

# Troubleshooting

## Ollama not running

SideCar auto-starts Ollama when it's not running. If that fails:

1. Verify Ollama is installed: `ollama --version`
2. Ensure `ollama` is in your PATH
3. Start it manually: `ollama serve`
4. Check if another process is using port 11434

## Model not found

If you get a "model not found" error:

- Use the model dropdown in SideCar to browse and install models
- Or pull the model manually: `ollama pull qwen3-coder:30b`
- Check available models: `ollama list`

## Connection errors

- **Ollama**: Verify `sidecar.baseUrl` is `http://localhost:11434` (the default)
- **Remote Ollama**: If running on another machine, use `http://<ip>:11434` and ensure the port is open
- **Firewall/proxy**: Check that your firewall allows connections to the configured URL
- **VPN**: Some VPNs block localhost connections — try disconnecting

## Anthropic API errors

| Error | Solution |
|-------|----------|
| 401 Unauthorized | Check your API key in `sidecar.apiKey` |
| 403 Forbidden | Verify your API key has the correct permissions |
| 404 Not Found | Check the model name (e.g., `claude-sonnet-4-6`, not `claude-3-sonnet`) |
| 429 Rate Limited | SideCar retries automatically with backoff. Wait a moment and try again |
| Base URL wrong | Set `sidecar.baseUrl` to exactly `https://api.anthropic.com` |

## Chat-only models

Some models don't support function calling:
- `gemma`, `gemma2`
- `llama2`
- `mistral`
- `neural-chat`
- `starling-lm`

SideCar auto-detects these and runs in **chat-only mode**. You'll see a "Chat-Only" badge in the header. Chat still works, but the agent can't use tools (read files, run commands, etc.).

Switch to a tool-capable model like `qwen3-coder`, `llama3.1`, or `command-r` for full agentic features.

## Agent loop not stopping

- Click the **Stop button** (red button that replaces Send during processing)
- Check `sidecar.agentMaxIterations` (default: 25) and `sidecar.agentMaxTokens` (default: 100,000)
- Lower these values if the agent runs too long on your hardware

## Inline completions not working

1. Enable them: `"sidecar.enableInlineCompletions": true`
2. Make sure a model is running (check the model dropdown)
3. Check that no other completion extension is conflicting (e.g., GitHub Copilot)
4. Try a different model — not all models support FIM (Fill-in-the-Middle)

## MCP server connection failed

- Verify the command and args in `sidecar.mcpServers` are correct
- Run the command manually to check for errors: `npx -y @modelcontextprotocol/server-filesystem /tmp`
- Check the "SideCar Agent" output channel for connection logs
- Ensure `npx` / `node` are in your PATH

## Error cards

SideCar classifies errors and shows actionable cards:

| Error type | Card action |
|------------|-------------|
| Connection | "Check Connection" — opens settings |
| Auth | "Check API Key" — opens settings |
| Model | "Install Model" — opens model dropdown |
| Timeout | "Retry" — resends the last message |

Click the action button on the error card to resolve common issues quickly.

## Getting help

- [GitHub Issues](https://github.com/nedonatelli/sidecar/issues) — report bugs or request features
- [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nedonatelli.sidecar-ai) — reviews and ratings
