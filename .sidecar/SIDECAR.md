# Project: ollama-vscode

This project is a VS Code extension that turns local and cloud LLMs into a full agentic coding assistant. It supports Ollama, Anthropic, OpenAI-compatible servers, Kickstand, OpenRouter, Groq, and Fireworks as backends. The extension provides an agent loop with 23+ tools (file ops, shell, git, web search, MCP), inline completions, code review, and a chat UI. It is designed to be highly customizable and extensible, with a focus on providing a seamless coding experience for developers.

## Tech Stack

* JavaScript
* TypeScript
* Node.js
* ES2022
* VS Code extension API
* TypeScript compiler options (target, module, etc.)
* Husky (npm scripts)
* Vitest (testing framework)

## Architecture

The architecture of the SideCar extension can be broken down into several components:

1. **Extension Entry Point**: `src/extension.ts` - Activates all subsystems and registers commands.
2. **Backend Abstraction**: `ApiBackend` interface (`backend.ts`) - Abstracts LLM communication, providing a unified API for different backends.
3. **Agent Loop**: `loop.ts` - Orchestrates the agent loop, processing tool calls and executing them in parallel.
4. **Shadow Workspaces**: `shadowWorkspace.ts` - Provides an opt-in feature for running agent tasks in an ephemeral git worktree.
5. **Audit Mode**: `auditBuffer.ts` - Processes writes and edits in-memory-only, with a focus on preventing silent disk writes.

## Key Files & Directories

| File/Directory | Description |
| --- | --- |
| `src/extension.ts` | Extension entry point, activating subsystems and registering commands. |
| `backend.ts` | Abstracts LLM communication, providing a unified API for different backends. |
| `loop.ts` | Orchestrates the agent loop, processing tool calls and executing them in parallel. |
| `shadowWorkspace.ts` | Provides an opt-in feature for running agent tasks in an ephemeral git worktree. |
| `auditBuffer.ts` | Processes writes and edits in-memory-only, with a focus on preventing silent disk writes. |

## Development

To install and build the extension:

1. Run `npm install`
2. Run `npm run compile` (compiles TypeScript code)
3. Run `npm run check` (runs all tests)

To test the extension:

1. Open the VS Code extension manager
2. Install the SideCar extension
3. Test various features and commands

## Code Conventions

The project follows standard JavaScript and TypeScript conventions, with a focus on readability and maintainability.

* Naming conventions:
	+ Variables: `camelCase`
	+ Functions: `camelCase` or `PascalCase`
	+ Classes: `CamelCase`
* File structure:
	+ `src/extension.ts`: extension entry point
	+ `backend.ts`: abstracts LLM communication
	+ `loop.ts`: orchestrates the agent loop
	+ ...
* Code organization:
	+ Separation of concerns (e.g., backend abstraction, agent loop)
	+ Modular code with clear interfaces

## Important Notes

* The project uses Husky for npm scripts and Vitest for testing.
* The SideCar extension is designed to be highly customizable and extensible.
* Audit mode provides an opt-in feature for running agent tasks in an ephemeral git worktree.

Note: This SIDECAR.md file only includes a summary of the project's structure, tech stack, and development process. It does not include all the details or implementation-specific information about the codebase.