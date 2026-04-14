## Pick a backend

SideCar works with several backends. Choose the one that best fits your workflow:

### Local (free, private, recommended default)

Install [Ollama](https://ollama.com), then pull a code-tuned model:

```bash
ollama pull qwen3-coder:30b
```

SideCar auto-detects `http://localhost:11434` — no API key needed. Everything stays on your machine.

### Anthropic / OpenAI (frontier models)

Open `Switch Backend` below to pick a profile, then `Set API Key` to paste your key. Keys are stored in VS Code's SecretStorage, never in `settings.json`.

### Kickstand *(coming soon)*

Kickstand is not yet officially released. The backend adapter ships today for anyone running a local dev build on `localhost:11435` — select it from the backend picker and the token is read from `~/.config/kickstand/token` automatically. Watch for the first-party Kickstand release announcement.

---

**Tip:** the status bar at the bottom-right shows which backend is active. It turns red if SideCar can't reach the backend — click the hover tooltip for one-click recovery actions.
