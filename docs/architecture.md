# SideCar Architecture

## Overview

SideCar is an AI-powered coding assistant for VS Code that operates as an autonomous agent. It can interact with your codebase, execute commands, and perform various development tasks using a combination of local LLMs (via Ollama) and cloud APIs (Anthropic Claude).

## Core Components

### 1. Extension Entry Point
- `extension.ts` - Main activation point that initializes all components
- Sets up webview chat interface
- Registers commands and keyboard shortcuts
- Initializes workspace indexing
- Configures tooling and agent components

### 2. Webview Interface
- `ChatViewProvider` - Manages the chat UI in VS Code
- Handles user messages and displays responses
- Routes commands to appropriate handlers
- Manages chat state and history

### 3. Agent Loop System
- `runAgentLoop` - Core autonomous agent execution engine
- Manages conversation flow with LLM
- Executes tools in response to model requests
- Handles iteration limits and context management
- Implements cycle detection and token budgeting

### 4. Tool System
- `tools.ts` - Registry of available tools for the agent
- Built-in tools for file operations, code search, shell commands, Git operations
- Custom tools defined in settings
- MCP (Model Control Protocol) integration for external tools
- Tool execution with approval modes and security checks

### 5. Context Management
- `WorkspaceIndex` - Indexes project files for context retrieval
- `astContext.ts` - AST-based context for code understanding
- Context compression and summarization to manage token limits
- File pattern filtering for workspace inclusion
- `streamingFileReader.ts` - Streaming reads with summary mode for large files (>50KB)
- `documentationIndexer.ts` - RAG system: discovers and indexes documentation, provides keyword-based search
- `agentMemory.ts` - Persistent learning: stores and retrieves patterns, decisions, and conventions

### 6. Communication Layer
- `SideCarClient` - LLM API client (Ollama or Anthropic)
- `ollamaBackend.ts` - Ollama-specific functionality
- `mcpManager.ts` - Manages MCP servers for external tool integration

## Data Flow

```
User Input → Webview → Chat Handlers → Agent Loop → LLM → Tool Execution → VS Code API
                              ↑
                              └── Tool Results → Agent Loop → LLM → Response
```

## Key Features

### Autonomous Mode
- Agent runs without user intervention
- Automatically executes tools based on LLM decisions
- Can generate and execute plans before implementation

### Plan Mode
- Generates a plan for approval before executing tools
- Allows user to review and modify the approach

### Tool Permissions
- Configurable approval modes (ask, allow, deny)
- Custom tool permissions
- Security scanning for file operations

### Context Management
- Workspace indexing with file pattern filtering
- Automatic context compression
- Conversation summarization to extend context window
- **Large file handling**: streaming reads with head+tail summary for files >50KB
- **Monorepo support**: lazy indexing, depth-limited traversal, multi-root workspace configuration
- **RAG context injection**: automatic documentation discovery and retrieval
- **Agent memory injection**: learned patterns and conventions injected alongside RAG results

### Integration Points
- Git operations (status, diff, commit, push, pull, branch, stash)
- Testing framework integration
- Security scanning
- Custom shell commands
- **Persistent learning**: automatic recording of successful patterns during agent runs
- MCP (Model Control Protocol) for external tool integration