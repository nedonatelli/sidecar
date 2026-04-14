## Pick a backend

SideCar works with several backends. Pick whichever matches how you want to run the assistant:

### Local (free, private, recommended default)

Install [Ollama](https://ollama.com), then pull a code-tuned model:

```bash
ollama pull qwen3-coder:30b
```

SideCar auto-detects `http://localhost:11434` — no API key needed. Nothing leaves your machine.

### Anthropic / OpenAI (frontier models)

Open `Switch Backend` below to pick a profile, then `Set API Key` to paste your key. Keys are stored in VS Code's SecretStorage, never in `settings.json`.

### Kickstand (self-hosted)

If you're running a Kickstand instance on `localhost:11435`, select it from the backend picker — the token is read from `~/.config/kickstand/token` automatically.

---

**Tip:** the status bar at the bottom-right shows which backend is active. It turns red if SideCar can't reach the backend — click the hover tooltip for one-click recovery actions.
