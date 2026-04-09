# SideCar Overview

SideCar is an AI-powered coding assistant for VS Code that operates as an autonomous agent. It can interact with your codebase, execute commands, and perform various development tasks using a combination of local LLMs (via Ollama) and cloud APIs (Anthropic Claude).

## Key Features

### Autonomous Agent
- Run full agent loops with local Ollama or cloud APIs
- Execute tools automatically based on LLM decisions
- Generate and execute plans before implementation
- Continuous operation until task completion or user interruption

### Multi-Modal Interface
- Chat-based interface in VS Code
- Inline code completion
- Code review and PR summarization
- Commit message generation

### Powerful Tool System
- Built-in tools for file operations, code search, shell commands, Git operations
- Custom tools defined in settings
- MCP (Model Control Protocol) integration for external tools
- Sub-agent spawning for complex tasks
- Tool execution with approval modes and security checks

### Context Management
- Workspace indexing with file pattern filtering
- Automatic context compression and summarization
- AST-based code understanding
- Conversation history management

### Integration Points
- Git operations (status, diff, commit, push, pull, branch, stash)
- Testing framework integration
- Security scanning
- Custom shell commands
- MCP (Model Control Protocol) for external tool integration

## Architecture Overview

SideCar is built as a VS Code extension with the following main components:

1. **Extension Entry Point** (`extension.ts`) - Initializes all components and sets up the UI
2. **Webview Interface** - Chat UI and command routing
3. **Agent Loop System** - Core autonomous execution engine
4. **Tool System** - Registry and execution of available tools
5. **Context Management** - Workspace indexing and context handling
6. **Communication Layer** - LLM API clients and VS Code API integration

## Supported Models

### Local Ollama
- Default: `qwen3-coder:30b` (or other local models)
- Works with any Ollama-compatible model
- No internet required for operation

### Cloud APIs
- Anthropic Claude models (e.g., `claude-sonnet-4-6`)
- OpenAI models (when configured)
- Other providers via custom API configuration

## Quick Start

1. Install SideCar extension in VS Code
2. Configure Ollama or API settings in VS Code settings
3. Open a workspace folder
4. Use the SideCar chat panel to interact with the AI agent
5. The agent can perform tasks like code explanation, bug fixing, refactoring, and more

## Usage Patterns

### Chat Mode
- Ask questions about your codebase
- Request explanations of code sections
- Get help with debugging issues

### Autonomous Mode
- Let the agent work on tasks without intervention
- Execute complex operations like code generation or refactoring

### Plan Mode
- Generate a plan for approval before executing tools
- Review and modify the approach before implementation

### Code Review
- Review current changes with the agent
- Generate PR summaries
- Create commit messages

### Testing
- Run test suites
- Generate new tests
- Analyze test failures

## Configuration

SideCar can be configured through VS Code settings with options for:
- API base URL and keys
- Model selection
- File patterns to include in context
- Tool permissions
- Custom tools
- Event hooks
- Scheduled tasks
- And more