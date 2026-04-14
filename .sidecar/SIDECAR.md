# Project: SideCar

SideCar is a VS Code extension that transforms local and cloud AI models into a full agentic coding assistant, enabling autonomous agent loops with file editing, command execution, and tool use. Unlike simple chat wrappers or autocomplete plugins, it provides true autonomous agent capabilities with full control over agent modes, tool permissions, and safety guardrails, supporting local Ollama, Anthropic Claude, and OpenAI-compatible servers.

## Tech Stack
- TypeScript (ES2022, NodeNext module system)
- VS Code Extension API
- Node.js runtime
- Ollama API client
- Anthropic API client
- Webview-based chat UI
- Tree-sitter for AST parsing
- MCP (Model Control Protocol) support
- Vitest for testing

## Architecture
The extension follows a modular architecture with clear separation of concerns:
- Entry point: `src/extension.ts` initializes all components and registers VS Code contributions
- Core agent system: `src/agent/` directory handles agent execution, modes, tools, and MCP integration
- Ollama/LLM communication: `src/ollama/` directory manages client creation and API interactions
- Webview UI: `src/webview/` provides chat interface and inline completion views
- Workspace management: `src/config/` handles workspace indexing, file patterns, and configuration
- File operations: `src/edits/` manages file reading, writing, and diff previews
- Terminal integration: `src/terminal/` handles shell sessions and error watching
- Testing: `src/**/*.test.ts` files with Vitest configuration

Components communicate through dependency injection and event-driven patterns. The main `SideCarClient` orchestrates communication between the agent system, Ollama API, and VS Code services.

## Key Files & Directories
| Path | Description |
|------|-------------|
| `src/extension.ts` | Main extension entry point, initializes all components |
| `src/agent/` | Core agent logic including agent loop, modes, tools, and MCP manager |
| `src/ollama/client.ts` | Main Ollama API client with model management |
| `src/webview/chatView.ts` | Webview-based chat UI implementation |
| `src/edits/proposedContentProvider.ts` | VS Code content provider for proposed file changes |
| `src/config/settings.ts` | Configuration management and provider detection |
| `src/agent/tools.ts` | Tool implementations for file operations, command execution, etc. |
| `src/terminal/manager.ts` | Terminal session management for shell commands |
| `src/completions/provider.ts` | Inline completion provider for real-time suggestions |

## Development
```bash
# Install dependencies
npm install

# Build the extension
npm run compile

# Run tests
npm run test

# Watch for changes during development
npm run watch

# Package the extension
npm run package
```

## Code Conventions
- File naming: PascalCase for classes, camelCase for functions and variables
- Module imports: Use relative paths with explicit `.js` extensions
- Error handling: Custom error classes with descriptive messages, try/catch blocks for async operations
- Testing: Vitest with `describe`, `it`, `expect` patterns, mock VS Code API in tests
- Configuration: Use VS Code's `workspace.getConfiguration()` with default values
- Async patterns: Prefer `async/await` over callbacks
- Type safety: Strict TypeScript compilation with explicit typing

## Important Notes
- Extension uses VS Code SecretStorage for API key management
- Configuration is stored in VS Code settings with default values in `package.json`
- The `sidecar.baseUrl` setting determines provider (Ollama vs Anthropic vs OpenAI-compatible)
- MCP server configuration supports stdio, HTTP, and SSE transports
- File patterns are configurable via `sidecar.filePatterns` with default language support
- The extension requires VS Code 1.88.0+ runtime
- Agent modes (cautious, autonomous, manual, plan, review) are controlled via `sidecar.agentMode`
- Workspace indexing persists across sessions in `.sidecar/cache/` directory
- Custom tools are defined in `sidecar.customTools` configuration array
- The extension supports background agents via `/bg <task>` command with concurrent limit of 3
- Tree-sitter parsing is used for AST extraction in TypeScript, JavaScript, Python, Rust, Go, and Java/Kotlin
- The `sidecar.completionGate.enabled` setting controls whether agent completion requires lint/test execution
- All file operations go through the `proposedContentProvider` for diff preview functionality
- The extension uses a `SideCarClient` singleton pattern for centralized LLM communication
- Custom modes are defined in `sidecar.customModes` with approval behavior and per-tool permissions
- Event hooks are configured via `sidecar.eventHooks` with onSave, onCreate, onDelete triggers
- Scheduled tasks are defined in `sidecar.scheduledTasks` with interval and prompt properties
- The extension supports both local Ollama and cloud providers through the `detectProvider` function
- Workspace trust is checked via `checkWorkspaceConfigTrust` function before agent execution
- The `sidecarDir` manages extension-specific directories in the workspace
- Symbol indexing uses `SymbolIndexer` and persists via `WorkspaceIndex` class
- Skills are loaded via `SkillLoader` from markdown files in the extension directory
- The `ProposedContentProvider` enables incremental diff updates during agent execution
- Terminal sessions are managed by `TerminalManager` with error watching via `TerminalErrorWatcher`
- The `EventHookManager` handles pre/post-execution hooks for tools
- The `Scheduler` manages recurring tasks defined in `sidecar.scheduledTasks`
- Inline chat is handled by `handleInlineChat` function with `SideCarCompletionProvider`
- Review functionality uses `reviewCurrentChanges`, `summarizePR`, and `generateCommitMessage` functions
- Pre-commit scanning is implemented in `runPreCommitScan` function
- The extension supports multiple LLM providers through `createClient` factory function
- Context limiting is handled by `sidecar.contextLimit` configuration with auto-detection
- The `SideCarLogger` provides structured logging for agent activities
- Custom tool permissions are managed via `sidecar.toolPermissions` object
- The extension supports both local and cloud-based LLM providers through provider detection
- Workspace indexing uses tree-sitter AST parsing for efficient code analysis
- The extension maintains a persistent file index across restarts in `.sidecar/cache/`