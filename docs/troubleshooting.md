---
title: Troubleshooting
layout: docs
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

## Slow model loading

Large models (especially 30B+ parameters) can take 10–30 seconds to load into memory the first time. This is normal — Ollama needs to read the model weights from disk into RAM/VRAM.

### What SideCar already does

SideCar **pre-warms** your configured model on activation. When you open VS Code, SideCar sends an empty request to Ollama in the background to load the model before you send your first message. You'll see `[SideCar] Pre-warmed model: <model>` in the output console.

### If pre-warming isn't fast enough

If you want the model ready before you even open VS Code, you can load it at computer startup using a macOS Launch Agent.

**Step 1:** Create the plist file:

```bash
cat > ~/Library/LaunchAgents/com.sidecar.prewarm.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.sidecar.prewarm</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>sleep 15 &amp;&amp; /usr/bin/curl -s -o /dev/null http://localhost:11434/api/generate -d '{"model":"qwen3-coder:30b","prompt":"","keep_alive":"30m"}'</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/sidecar-prewarm.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/sidecar-prewarm.log</string>
</dict>
</plist>
EOF
```

> **Note:** Replace `qwen3-coder:30b` with whichever model you have configured in `sidecar.model`.

**Step 2:** Register it:

```bash
launchctl load ~/Library/LaunchAgents/com.sidecar.prewarm.plist
```

On every login, macOS will wait 15 seconds for Ollama to start, then load your model into memory. The model stays loaded for 30 minutes — plenty of time to open VS Code and start chatting.

**To remove it:**

```bash
launchctl unload ~/Library/LaunchAgents/com.sidecar.prewarm.plist
rm ~/Library/LaunchAgents/com.sidecar.prewarm.plist
```

**Logs:** Check `/tmp/sidecar-prewarm.log` if the warm-up isn't working.

### Other tips for faster loading

- **Use a smaller model** — `gemma2` (5GB) loads in a few seconds vs. `qwen3-coder:30b` (18GB)
- **Keep models warm** — Set the `OLLAMA_KEEP_ALIVE` environment variable to `24h` so Ollama doesn't unload the model between sessions
- **SSD storage** — NVMe SSDs load models significantly faster than HDDs

## Request timeout

If SideCar shows "Request timed out after Ns waiting for the model", the model didn't respond within the timeout window. This usually means:

- **Model is loading** — large models (30B+) take time to load into memory. See [Slow model loading](#slow-model-loading) above
- **Prompt too large** — the system prompt + workspace context exceeds what the model can handle. Try reducing `sidecar.maxFiles` or disabling workspace context temporarily (`sidecar.includeWorkspace: false`)
- **Network issue** — for remote backends, check your connection

Adjust the timeout via `sidecar.requestTimeout` (default: 120 seconds). Set to `0` to disable the timeout entirely.

## Agent loop not stopping

- Click the **Stop button** (red button that replaces Send during processing)
- **Cycle detection** — SideCar automatically halts if the agent repeats the same tool call with identical arguments
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

## Terminal error interception isn't firing

SideCar's terminal error watcher uses VS Code's shell integration API. If the **Diagnose in chat** notification never appears when a command fails, check:

1. **Shell integration is active.** Run `echo $VSCODE_SHELL_INTEGRATION` in your terminal — it should print `1`. If it's empty, your shell isn't integrated. POSIX shells (bash, zsh, fish) and PowerShell integrate automatically in recent VS Code versions; other shells may need manual setup.
2. **VS Code version is 1.93+.** The shell-execution events (`onDidStartTerminalShellExecution` / `onDidEndTerminalShellExecution`) were added in 1.93. On older versions the watcher silently no-ops.
3. **The setting is enabled.** Check `sidecar.terminalErrorInterception` in Settings — it defaults to `true` but may have been toggled off.
4. **The command isn't being deduped.** Identical command lines within a 30-second cooldown window only notify once. Wait 30s and try again, or run a different command.
5. **You're not in SideCar's own terminal.** The terminal named `SideCar` is skipped to avoid feedback loops from agent-driven shell commands.
6. **The exit code was actually non-zero.** Some commands that look like errors (e.g., `grep` returning 1 when there are no matches) exit with specific non-zero codes that are intentional. These still trigger the notification — you can dismiss them or disable the feature if they're too noisy.

## Error cards

SideCar classifies errors and shows actionable cards:

| Error type | When you'll see it | Card action |
|------------|--------------------|-------------|
| Connection | `ECONNREFUSED`, `ENOTFOUND`, network failures | "Check Connection" — opens settings |
| Auth | 401, 403, "Invalid API key" | "Check API Key" — opens settings (use `SideCar: Set API Key` to update via SecretStorage) |
| Model | 404 with "model not found" | "Install Model" — opens model dropdown |
| Rate limit | 429, "rate limit", "too many requests" | "Wait and Retry" |
| Server error | 500, 502, 503, 504, "overloaded" | "Retry" |
| Content policy | Anthropic safety violations, "flagged" | (no action — refine your prompt) |
| Token limit | "token limit exceeded", "too long", "maximum tokens" | "Reduce Context" — try lowering `sidecar.maxFiles` or running `/compact` |
| Timeout | Request didn't complete within `requestTimeout` | "Retry" — resends the last message |

Click the action button on the error card to resolve common issues quickly.

### Anthropic-specific tips

- **Rate limit (429)**: Anthropic has per-minute and per-day token limits. SideCar automatically retries with exponential backoff. If you hit limits frequently, either upgrade your tier or set `sidecar.dailyBudget` to throttle yourself.
- **Server error (overloaded)**: Anthropic occasionally returns 529/overloaded during peak demand. Wait 30 seconds and retry, or use the `/model` command to switch to a different provider temporarily.
- **Token limit**: Long conversations exceed the model's context window. Use `/compact` to summarize older turns, or `/reset` to start fresh.

## Model returns empty responses

If the model responds with nothing (empty content, `done` immediately):

- **Context too large** — local models have a limited context window. SideCar caps local models at 8K tokens. Reduce `sidecar.maxFiles` or unpin large files
- **Tool definitions overwhelm the model** — ~~~23 tool definitions add ~10K chars. Smaller models may not handle this well. Try a larger model or use chat-only mode
- **Wrong model format** — some models don't support the chat template or tool format. Try a different model

## Getting help

- [GitHub Issues](https://github.com/nedonatelli/sidecar/issues) — report bugs or request features
- [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nedonatelli.sidecar-ai) — reviews and ratings
- **Email**: [sidecarai.vscode@gmail.com](mailto:sidecarai.vscode@gmail.com)
