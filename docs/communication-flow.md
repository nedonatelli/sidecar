# SideCar Communication Flow

## Overview

SideCar operates as a multi-layered system where communication flows between the VS Code extension, the LLM backend, and various system components. The architecture supports both local Ollama deployments and cloud APIs like Anthropic Claude.

## Component Interactions

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            VS Code Extension                            │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────┐  │
│  │  Webview    │    │  Chat       │    │  Agent      │    │  Tools  │  │
│  │  Interface  │───▶│  Handlers   │───▶│  Loop       │───▶│  System │  │
│  └─────────────┘    └─────────────┘    └─────────────┘    └─────────┘  │
│                                                                         │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────┐  │
│  │  Commands   │    │  Keyboard   │    │  Context    │    │  Git    │  │
│  │  & Shortcuts│    │  Shortcuts  │    │  Manager    │    │  System │  │
│  └─────────────┘    └─────────────┘    └─────────────┘    └─────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────────────────────────┐
                    │        SideCar Client               │
                    │                                     │
                    │  ┌─────────────┐   ┌─────────────┐   │
                    │  │  Ollama     │   │  Anthropic  │   │
                    │  │  Backend    │   │  Backend    │   │
                    │  └─────────────┘   └─────────────┘   │
                    │                                     │
                    │  ┌─────────────────────────────────┐ │
                    │  │     LLM API Interface         │ │
                    │  │                                 │ │
                    │  │  - Chat Completion              │ │
                    │  │  - Tool Definition              │ │
                    │  │  - Streaming Response           │ │
                    │  └─────────────────────────────────┘ │
                    └─────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────────────────────────┐
                    │         LLM Model                   │
                    │                                     │
                    │  ┌───────────────────────────────┐  │
                    │  │     Local Ollama              │  │
                    │  │  (qwen3-coder, llama3, etc.)  │  │
                    │  └───────────────────────────────┘  │
                    │                                     │
                    │  ┌───────────────────────────────┐  │
                    │  │     Cloud API (Anthropic)     │  │
                    │  │  (claude-sonnet, etc.)        │  │
                    │  └───────────────────────────────┘  │
                    └─────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────────────────────────┐
                    │         VS Code API                 │
                    │                                     │
                    │  ┌───────────────────────────────┐  │
                    │  │  File Operations              │  │
                    │  │  - Read/Write/Edit Files      │  │
                    │  │  - Search Files               │  │
                    │  └───────────────────────────────┘  │
                    │                                     │
                    │  ┌───────────────────────────────┐  │
                    │  │  Git Operations               │  │
                    │  │  - Status, Diff, Commit       │  │
                    │  │  - Branch, Push, Pull         │  │
                    │  └───────────────────────────────┘  │
                    │                                     │
                    │  ┌───────────────────────────────┐  │
                    │  │  Terminal Operations          │  │
                    │  │  - Shell Commands             │  │
                    │  │  - Process Management         │  │
                    │  └───────────────────────────────┘  │
                    │                                     │
                    │  ┌───────────────────────────────┐  │
                    │  │  Language Services            │  │
                    │  │  - Diagnostics                │  │
                    │  │  - Tests                      │  │
                    │  └───────────────────────────────┘  │
                    └─────────────────────────────────────┘
```

## Data Flow Details

### 1. User Interaction Flow
1. User types message in chat interface
2. Webview sends message to Chat Handlers
3. Handlers process message and prepare for agent loop
4. Message sent to agent loop for processing

### 2. Agent Loop Flow
1. Agent loop receives conversation history
2. Sends request to LLM with available tools
3. LLM responds with text and/or tool calls
4. Agent executes tools in parallel
5. Tool results fed back to LLM
6. Loop continues until completion or tool limit reached

### 3. Tool Execution Flow
1. Tool selected by LLM
2. Approval check (if required)
3. Security scan (especially for file operations)
4. Tool execution via VS Code API
5. Results returned to agent loop

### 4. LLM Communication Flow
- **Ollama**: Direct HTTP API calls to local Ollama server
- **Anthropic**: HTTPS API calls to Anthropic endpoints
- Both support streaming responses for real-time updates
- Tool definitions passed to model for structured tool calling

## Key Communication Patterns

### 1. Streaming Responses
- LLM responses streamed to webview in real-time
- Tool output streamed during execution
- Progress updates during long-running operations

### 2. Asynchronous Operations
- Parallel tool execution for performance
- Background shell commands
- Async file operations

### 3. Context Management
- Conversation history passed to LLM
- Workspace context built from indexed files
- Context compression when approaching token limits

### 4. Error Handling
- Graceful handling of LLM timeouts
- Tool execution failures
- Network connectivity issues
- Permission denials