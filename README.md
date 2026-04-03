# SideCar — Ollama AI Assistant for VS Code

**SideCar** is a Visual Studio Code extension that brings the power of [Ollama](https://ollama.com) large language models directly into your editor. Use Ollama to chat with AI models like Llama 3, Mistral, Gemma, CodeLlama, and more — all running locally on your machine with no API keys, no cloud services, and no data leaving your computer.

> The best way to use Ollama in VS Code. A free, open-source, local AI copilot alternative.

## Features

### AI Chat powered by Ollama
- Streaming chat responses in a dedicated VS Code sidebar panel
- **Workspace-aware** — SideCar automatically reads your project files so the AI understands your code
- Switch between installed Ollama models with a single click
- **Custom model support** — use any model available in Ollama, including your own custom models
- Download and install new Ollama models on-demand with progress tracking
- Customizable system prompts via VS Code settings
- Chat history persists when the panel is hidden and reopened
- Ollama starts automatically when you open SideCar — no need to manually run `ollama serve`

### File Operations
- **Read files** — attach files from the active editor or file picker to provide context to the AI
- **Save code** — save code blocks from AI responses directly to disk
- **Move/rename files** — use natural language or slash commands to move files in your workspace

### GitHub Integration
- **Clone repos** — clone repositories from GitHub into your workspace
- **Pull requests** — list, view, and create PRs
- **Issues** — list, view, and create issues
- **Commit history** — view recent commits
- **Diffs** — view staged/unstaged changes or compare refs
- **Push/pull** — push and pull changes from the chat
- **Browse** — explore repo files on GitHub

## Requirements

- **[Ollama](https://ollama.com)** installed and available in your PATH
- **Visual Studio Code** 1.88.0 or later

## Getting Started

1. Install [Ollama](https://ollama.com) if you haven't already
2. Install the SideCar extension from the VS Code Marketplace
3. Click the SideCar icon in the activity bar to open the chat panel
4. Start chatting — SideCar will launch Ollama automatically if it's not running
5. Use the model selector dropdown to switch models or install new ones

## Chat Commands

SideCar supports both slash commands and natural language for common operations.

### File Operations

| Command | Example |
|---------|---------|
| `/move source dest` | `/move src/old.ts src/new.ts` |
| `move file "source" to "dest"` | `move file "utils.ts" to "lib/utils.ts"` |
| `rename file "source" to "dest"` | `rename file "old.ts" to "new.ts"` |

### GitHub / Git Commands

| Command | Example |
|---------|---------|
| `/clone <url>` | `/clone https://github.com/user/repo` |
| `/prs [owner/repo]` | `/prs` or `/prs user/repo` |
| `/pr <number>` | `/pr 42` or `show pr #42` |
| `/create pr "title" base head` | `/create pr "Add feature" main feature-branch` |
| `/issues [owner/repo]` | `/issues` or `show issues` |
| `/issue <number>` | `/issue 15` or `show issue #15` |
| `/create issue "title" ["body"]` | `/create issue "Fix bug" "Description here"` |
| `/log [count]` | `/log` or `show commits 20` |
| `/diff [ref1] [ref2]` | `/diff` or `show diff HEAD~3` |
| `/push` | `/push` or `push changes` |
| `/pull` | `/pull` or `pull changes` |
| `/browse [path]` | `/browse src/` or `browse repo` |

GitHub commands auto-detect the repository from your git remote. You can also specify a repo explicitly: `/prs owner/repo`.

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `ollama.model` | `llama3` | Ollama model to use for chat |
| `ollama.systemPrompt` | `""` | Custom system prompt (optional) |
| `ollama.includeWorkspace` | `false` | Include workspace files in context |
| `ollama.filePatterns` | `["**/*.ts", ...]` | Glob patterns for workspace context |
| `ollama.maxFiles` | `10` | Max files to include in context |

## Supported Models

SideCar provides quick access to popular Ollama models from the model panel:

- Llama 3 / 3.1 / 3.2
- Mistral / Mixtral
- CodeLlama
- Phi / Phi 3
- Qwen 2 / 2.5
- DeepSeek Coder
- Gemma / Gemma 2
- LLaVA (multimodal)
- Nomic Embed Text

Any model available through Ollama can be installed directly from the extension.

## How It Works

SideCar connects to Ollama running on `localhost:11434`. When you open the SideCar panel, the extension checks if Ollama is running and starts it automatically if needed. All AI inference happens locally on your machine — your conversations and code never leave your computer.

## Disclaimer

SideCar is an independent project by Nicholas Donatelli and is not affiliated with, endorsed by, or sponsored by Ollama, Meta (Llama), Mistral AI, Google (Gemma), or any other model provider. All product and company names are trademarks or registered trademarks of their respective holders. Use of these names is for identification and compatibility purposes only. The author assumes no liability for any issues arising from the use of third-party services, APIs, or AI models accessed through this extension.

## License

[MIT](LICENSE)
