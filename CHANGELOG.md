# Changelog

All notable changes to the SideCar extension will be documented in this file.

## [0.0.1] - 2026-04-03

### Added
- Interactive AI chat sidebar with streaming responses
- Model selection and switching via dropdown panel
- On-demand model download and installation with progress tracking
- Customizable system prompts via VS Code settings
- File attachment — attach active editor or browse for files to include as context
- Code block rendering with Save button to write code to disk
- File move/rename via chat commands (`/move`, `move file ... to ...`)
- GitHub integration:
  - Clone repositories (`/clone`)
  - List, view, and create pull requests (`/prs`, `/pr`, `/create pr`)
  - List, view, and create issues (`/issues`, `/issue`, `/create issue`)
  - View commit history (`/log`, `show commits`)
  - View diffs (`/diff`, `show diff`)
  - Push and pull changes (`/push`, `/pull`)
  - Browse repo files on GitHub (`/browse`)
- Auto-start Ollama process when not running
- Nonce-based Content Security Policy for webview security
- VSCode theme-aware styling
